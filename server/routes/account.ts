// 認証・ユーザー・設定の API。

import { APP_VERSION } from "../../src/config/flags";
import { defaultNotifyPrefs, RECORDING_PRESETS } from "../../src/shared/defaults";
import type { Criterion, InterviewTemplate, NotifyPrefs, QuestionPlan, Role, SessionInfo, Settings } from "../../src/shared/types";
import {
  arr,
  bool,
  int,
  LOGIN_ID_RE,
  num,
  obj,
  oneOf,
  password,
  str,
  ValidationError,
} from "../../src/shared/validate";
import { burnPasswordCheck, hashPassword, SESSION_COOKIE, setupCodeMatches, verifyPassword } from "../auth";
import type { AppContext } from "../context";
import { HttpError, readJson, setCookie, type Ctx, type Router } from "../http";
import { mustSetupTotp } from "../access";
import { mailEnabled, mailStatus, sendMailOrThrow } from "../mail";
import { isAllowedWebhookUrl } from "../notify";
import { newId, type UserRecord } from "../store";
import { hashRecovery, looksLikeRecovery, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "../totp";
import { ffmpegPath } from "../transcode";
import { whisperCli } from "../transcribe";

function cookieSecure(app: AppContext, c: Ctx): boolean {
  return app.config.cookieSecure === "auto" ? c.secure : app.config.cookieSecure;
}

function startSession(app: AppContext, c: Ctx, user: UserRecord): void {
  const token = app.sessions.create(user.id);
  setCookie(c.res, SESSION_COOKIE, token, { maxAgeSec: app.sessions.ttlSec, secure: cookieSecure(app, c) });
}

function loginIdOf(v: unknown): string {
  const s = str(v, "ログインID", { max: 64, min: 3 });
  if (!LOGIN_ID_RE.test(s)) throw new ValidationError("ログインIDは半角英数字と . _ @ - で入力してください");
  return s;
}

/** メールアドレス(空でもよい)。見た目の確認だけ(届くかどうかはテストメールで確かめる) */
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function emailOf(v: unknown): string {
  const s = str(v, "メールアドレス", { max: 254, optional: true }).trim();
  if (s && !EMAIL_RE.test(s)) throw new ValidationError("メールアドレスの形式が正しくありません");
  return s;
}

function notifyOf(v: unknown, current: NotifyPrefs): NotifyPrefs {
  if (v === undefined || v === null) return current;
  const o = obj(v, "お知らせの設定");
  const pick = (k: keyof NotifyPrefs) => (o[k] === undefined ? current[k] : bool(o[k], "お知らせの設定"));
  return { evaluation: pick("evaluation"), dayBefore: pick("dayBefore"), live: pick("live"), admin: pick("admin") };
}

function newUserFields(role: Role, email: string): Pick<UserRecord, "email" | "notify" | "totp" | "totpPending"> {
  return { email, notify: defaultNotifyPrefs(role), totp: null, totpPending: null };
}

const TICKET_TTL_MS = 5 * 60_000;
const TICKET_MAX_ATTEMPTS = 5;

function pruneTickets(app: AppContext): void {
  const now = Date.now();
  for (const [k, t] of app.loginTickets) if (t.expiresAt <= now) app.loginTickets.delete(k);
}

export function registerAccountRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/health", "none", () => ({ ok: true, version: APP_VERSION }));

  r.get("/api/session", "none", (c): SessionInfo => ({
    user: c.user ? store.publicUser(c.user) : null,
    needsSetup: store.users.size === 0,
    orgName: store.settings.orgName,
    version: APP_VERSION,
    features: {
      transcription: !!c.user && store.settings.transcription.enabled && !!whisperCli(app) && !!ffmpegPath(),
      mail: !!c.user && mailEnabled(app),
    },
    mustSetupTotp: !!c.user && mustSetupTotp(app, c.user),
  }));

  // ---------------------------------------------------------------- 初期設定
  r.post("/api/setup", "none", async (c) => {
    const body = obj(await readJson(c));
    if (store.users.size > 0 || !app.setup.code) throw new HttpError(409, "初期設定は完了しています");
    if (app.limiter.blocked(c.ip, "__setup__")) {
      throw new HttpError(429, "試行回数が多すぎます。しばらく待ってから再度お試しください");
    }
    const code = str(body.setupCode, "初期設定コード", { max: 20, min: 1 });
    if (!setupCodeMatches(code, app.setup.code)) {
      app.limiter.fail(c.ip, "__setup__");
      throw new HttpError(403, "初期設定コードが違います。サーバーのログに表示されたコードを入力してください");
    }
    const orgName = str(body.orgName, "団体名", { max: 80, optional: true });
    const loginId = loginIdOf(body.loginId);
    const name = str(body.name, "氏名", { max: 40, min: 1 });
    const pw = password(body.password);
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: newId(),
      loginId,
      name,
      role: "admin",
      disabled: false,
      createdAt: now,
      passwordHash: await hashPassword(pw),
      passwordChangedAt: now,
      ...newUserFields("admin", ""),
    };
    // 非同期処理の間に別のリクエストで作られていないか再確認
    if (store.users.size > 0) throw new HttpError(409, "初期設定は完了しています");
    store.users.set(user.id, user);
    await store.saveUsers();
    store.settings = { ...store.settings, orgName, updatedAt: now, updatedBy: user.id };
    await store.saveSettings();
    app.setup.code = null;
    startSession(app, c, user);
    await app.audit.write({ userId: user.id, userName: user.name, action: "setup", interviewId: null, detail: null, ip: c.ip });
    return { user: store.publicUser(user) };
  });

  // ---------------------------------------------------------------- ログイン
  r.post("/api/login", "none", async (c) => {
    const body = obj(await readJson(c));
    const loginId = str(body.loginId, "ログインID", { max: 64, min: 1 });
    const pw = typeof body.password === "string" ? body.password : "";
    if (app.limiter.blocked(c.ip, loginId)) {
      throw new HttpError(429, "ログインの失敗が続いたため、一時的にロックしています。15分ほど待ってから再度お試しください");
    }
    const user = store.userByLogin(loginId);
    const ok = user && !user.disabled ? await verifyPassword(pw, user.passwordHash) : (await burnPasswordCheck(pw), false);
    if (!user || !ok) {
      app.limiter.fail(c.ip, loginId);
      await app.audit.write({ userId: null, userName: null, action: "login_failed", interviewId: null, detail: loginId.slice(0, 64), ip: c.ip });
      throw new HttpError(401, "ログインIDまたはパスワードが違います");
    }
    // 2段階認証を設定している人は、確認コードを入れるまでログインさせない
    if (user.totp) {
      pruneTickets(app);
      const ticket = newId(24);
      app.loginTickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
      return { totpRequired: true, ticket };
    }
    app.limiter.succeed(c.ip, loginId);
    startSession(app, c, user);
    await app.audit.write({ userId: user.id, userName: user.name, action: "login", interviewId: null, detail: null, ip: c.ip });
    return { user: store.publicUser(user) };
  });

  // ログインの2段目: 認証アプリの確認コード、または予備のコード
  r.post("/api/login/totp", "none", async (c) => {
    const body = obj(await readJson(c));
    const ticketId = str(body.ticket, "ログインの手続き", { max: 64, min: 1 });
    const code = str(body.code, "確認コード", { max: 20, min: 1 });
    pruneTickets(app);
    const ticket = app.loginTickets.get(ticketId);
    const user = ticket ? store.users.get(ticket.userId) : undefined;
    if (!ticket || !user || user.disabled || !user.totp) {
      app.loginTickets.delete(ticketId);
      throw new HttpError(401, "時間がたったため、もう一度ログインしてください");
    }
    if (app.limiter.blocked(c.ip, user.loginId)) {
      throw new HttpError(429, "ログインの失敗が続いたため、一時的にロックしています。15分ほど待ってから再度お試しください");
    }
    const result = await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(user.id);
      if (!u?.totp) return null;
      const step = verifyTotp(u.totp.secret, code, u.totp.lastStep);
      if (step !== null) {
        u.totp.lastStep = step;
        await store.saveUsers();
        return "totp" as const;
      }
      if (looksLikeRecovery(code)) {
        const h = hashRecovery(code);
        const i = u.totp.recovery.indexOf(h);
        if (i >= 0) {
          u.totp.recovery.splice(i, 1);
          await store.saveUsers();
          return "recovery" as const;
        }
      }
      return null;
    });
    if (!result) {
      ticket.attempts++;
      if (ticket.attempts >= TICKET_MAX_ATTEMPTS) app.loginTickets.delete(ticketId);
      app.limiter.fail(c.ip, user.loginId);
      await app.audit.write({ userId: user.id, userName: user.name, action: "login_failed", interviewId: null, detail: "2段階認証", ip: c.ip });
      throw new HttpError(401, ticket.attempts >= TICKET_MAX_ATTEMPTS ? "確認コードが違います。もう一度ログインしてください" : "確認コードが違います");
    }
    app.loginTickets.delete(ticketId);
    app.limiter.succeed(c.ip, user.loginId);
    startSession(app, c, user);
    await app.audit.write({ userId: user.id, userName: user.name, action: "login", interviewId: null, detail: result === "recovery" ? "予備のコード" : "2段階認証", ip: c.ip });
    return { user: store.publicUser(user), recoveryRemaining: user.totp!.recovery.length };
  });

  r.post("/api/logout", "none", (c) => {
    app.sessions.destroy(c.sessionToken ?? undefined);
    setCookie(c.res, SESSION_COOKIE, "", { maxAgeSec: 0, secure: cookieSecure(app, c) });
    return { ok: true };
  });

  r.post("/api/me/password", "user", async (c) => {
    const body = obj(await readJson(c));
    const user = c.user!;
    const current = typeof body.current === "string" ? body.current : "";
    if (!(await verifyPassword(current, user.passwordHash))) throw new HttpError(400, "現在のパスワードが違います");
    const next = password(body.next, "新しいパスワード");
    user.passwordHash = await hashPassword(next);
    user.passwordChangedAt = new Date().toISOString();
    await store.saveUsers();
    app.sessions.destroyUser(user.id, c.sessionToken ?? undefined);
    await app.audit.write({ userId: user.id, userName: user.name, action: "password_change", interviewId: null, detail: null, ip: c.ip });
    return { ok: true };
  });

  // ---------------------------------------------------------------- 2段階認証
  r.get("/api/me/totp", "user", (c) => {
    const u = c.user!;
    return { enabled: !!u.totp, enabledAt: u.totp?.enabledAt ?? null, recoveryRemaining: u.totp?.recovery.length ?? 0 };
  });

  // 設定を始める: 秘密の鍵を作り、認証アプリに登録してもらう(確認コードを入れるまで有効にしない)
  r.post("/api/me/totp/setup", "user", async (c) => {
    const out = await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(c.user!.id)!;
      if (u.totp) throw new HttpError(409, "2段階認証はすでに有効です");
      u.totpPending = { secret: newTotpSecret(), createdAt: new Date().toISOString() };
      await store.saveUsers();
      return u.totpPending.secret;
    });
    const issuer = store.settings.orgName.trim() ? `面接記録(${store.settings.orgName.trim()})` : "面接記録";
    return { secret: out, uri: otpauthUri(out, c.user!.loginId, issuer) };
  });

  r.post("/api/me/totp/enable", "user", async (c) => {
    const body = obj(await readJson(c));
    const code = str(body.code, "確認コード", { max: 20, min: 1 });
    const codes = newRecoveryCodes();
    await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(c.user!.id)!;
      if (u.totp) throw new HttpError(409, "2段階認証はすでに有効です");
      const pending = u.totpPending;
      if (!pending || Date.now() - Date.parse(pending.createdAt) > 30 * 60_000) {
        throw new HttpError(409, "時間がたったため、最初からやり直してください");
      }
      const step = verifyTotp(pending.secret, code, -1);
      if (step === null) throw new HttpError(400, "確認コードが違います。認証アプリに表示されている6桁の数字を入れてください");
      u.totp = { secret: pending.secret, enabledAt: new Date().toISOString(), lastStep: step, recovery: codes.map(hashRecovery) };
      u.totpPending = null;
      await store.saveUsers();
    });
    // ほかの端末のログインは解除する(この先は確認コードが必要)
    app.sessions.destroyUser(c.user!.id, c.sessionToken ?? undefined);
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "totp_enable", interviewId: null, detail: null, ip: c.ip });
    return { recoveryCodes: codes };
  });

  // 予備のコードを作り直す(今の確認コードが必要)
  r.post("/api/me/totp/recovery", "user", async (c) => {
    const body = obj(await readJson(c));
    const code = str(body.code, "確認コード", { max: 20, min: 1 });
    const codes = newRecoveryCodes();
    await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(c.user!.id)!;
      if (!u.totp) throw new HttpError(409, "2段階認証が有効ではありません");
      const step = verifyTotp(u.totp.secret, code, u.totp.lastStep);
      if (step === null) throw new HttpError(400, "確認コードが違います");
      u.totp.lastStep = step;
      u.totp.recovery = codes.map(hashRecovery);
      await store.saveUsers();
    });
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "totp_recovery", interviewId: null, detail: null, ip: c.ip });
    return { recoveryCodes: codes };
  });

  r.post("/api/me/totp/disable", "user", async (c) => {
    const body = obj(await readJson(c));
    const pw = typeof body.password === "string" ? body.password : "";
    const me = c.user!;
    if (!(await verifyPassword(pw, me.passwordHash))) throw new HttpError(400, "パスワードが違います");
    if (me.role === "admin" && store.settings.security.requireTotpForAdmins) {
      throw new HttpError(409, "管理者は2段階認証が必須の設定のため、無効にできません");
    }
    await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(me.id)!;
      u.totp = null;
      u.totpPending = null;
      await store.saveUsers();
    });
    await app.audit.write({ userId: me.id, userName: me.name, action: "totp_disable", interviewId: null, detail: null, ip: c.ip });
    return { ok: true };
  });

  // 自分のメールアドレスとお知らせの設定
  r.get("/api/me", "user", (c) => ({ user: store.accountView(c.user!) }));

  r.put("/api/me/notify", "user", async (c) => {
    const body = obj(await readJson(c));
    const email = body.email === undefined ? undefined : emailOf(body.email);
    const user = await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(c.user!.id);
      if (!u) throw new HttpError(404, "ユーザーが見つかりません");
      if (email !== undefined) u.email = email;
      u.notify = notifyOf(body.notify, u.notify);
      await store.saveUsers();
      return u;
    });
    await app.audit.write({ userId: user.id, userName: user.name, action: "notify_update", interviewId: null, detail: null, ip: c.ip });
    return { user: store.accountView(user) };
  });

  // ---------------------------------------------------------------- ユーザー
  // 管理者の画面用(メールアドレス・お知らせの設定を含む)
  r.get("/api/admin/users", "admin", () => ({
    users: [...store.users.values()].map((u) => store.accountView(u)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));

  r.get("/api/users", "user", () => ({
    users: [...store.users.values()]
      .map((u) => store.publicUser(u))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));

  r.post("/api/users", "admin", async (c) => {
    const body = obj(await readJson(c));
    const loginId = loginIdOf(body.loginId);
    if (store.userByLogin(loginId)) throw new HttpError(409, "このログインIDは使われています");
    const name = str(body.name, "氏名", { max: 40, min: 1 });
    const role = oneOf(body.role, "権限", ["admin", "interviewer"] as const);
    const email = emailOf(body.email);
    const passwordHash = await hashPassword(password(body.password, "初期パスワード"));
    const user = await store.withLock(USERS_LOCK, async () => {
      // ハッシュ計算の間に同じログインIDで作られていないか(二重送信)を確かめ直す
      if (store.userByLogin(loginId)) throw new HttpError(409, "このログインIDは使われています");
      const now = new Date().toISOString();
      const user: UserRecord = {
        id: newId(),
        loginId,
        name,
        role,
        disabled: false,
        createdAt: now,
        passwordHash,
        passwordChangedAt: now,
        ...newUserFields(role, email),
      };
      store.users.set(user.id, user);
      await store.saveUsers();
      return user;
    });
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "user_create", interviewId: null, detail: `${user.loginId} (${user.role})`, ip: c.ip });
    return { user: store.accountView(user) };
  });

  r.patch("/api/users/:id", "admin", async (c) => {
    const body = obj(await readJson(c));
    if (!store.users.has(c.params.id)) throw new HttpError(404, "ユーザーが見つかりません");
    // すべて検証してから反映する(途中で入力エラーになっても中途半端に変わらないように)
    const name = body.name === undefined ? undefined : str(body.name, "氏名", { max: 40, min: 1 });
    const role = body.role === undefined ? undefined : oneOf(body.role, "権限", ["admin", "interviewer"] as const);
    const disabled = body.disabled === undefined ? undefined : bool(body.disabled, "無効化");
    const email = body.email === undefined ? undefined : emailOf(body.email);
    const passwordHash =
      body.password === undefined ? undefined : await hashPassword(password(body.password, "新しいパスワード"));

    const { user, changes } = await store.withLock(USERS_LOCK, async () => {
      const user = store.users.get(c.params.id);
      if (!user) throw new HttpError(404, "ユーザーが見つかりません");
      const willBeAdmin = (role ?? user.role) === "admin" && !(disabled ?? user.disabled);
      if (user.role === "admin" && !user.disabled && !willBeAdmin && activeAdmins(app, user.id) === 0) {
        throw new HttpError(409, "管理者が1人もいなくなるため変更できません");
      }
      if (disabled && user.id === c.user!.id) throw new HttpError(409, "自分自身は無効にできません");

      const changes: string[] = [];
      if (name !== undefined) {
        user.name = name;
        changes.push("name");
      }
      if (role !== undefined) {
        user.role = role;
        changes.push(`role=${role}`);
      }
      if (disabled !== undefined) {
        user.disabled = disabled;
        changes.push(disabled ? "disabled" : "enabled");
      }
      if (passwordHash !== undefined) {
        user.passwordHash = passwordHash;
        user.passwordChangedAt = new Date().toISOString();
        changes.push("password");
      }
      if (email !== undefined && email !== user.email) {
        user.email = email;
        changes.push("email");
      }
      await store.saveUsers();
      if (disabled || passwordHash !== undefined) app.sessions.destroyUser(user.id);
      return { user, changes };
    });
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "user_update", interviewId: null, detail: `${user.loginId}: ${changes.join(", ")}`, ip: c.ip });
    return { user: store.accountView(user) };
  });

  // スマートフォンをなくした人の2段階認証を解除する(本人は次のログインで設定し直す)
  r.post("/api/users/:id/totp/reset", "admin", async (c) => {
    const user = await store.withLock(USERS_LOCK, async () => {
      const u = store.users.get(c.params.id);
      if (!u) throw new HttpError(404, "ユーザーが見つかりません");
      u.totp = null;
      u.totpPending = null;
      await store.saveUsers();
      return u;
    });
    app.sessions.destroyUser(user.id);
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "totp_reset", interviewId: null, detail: user.loginId, ip: c.ip });
    return { user: store.accountView(user) };
  });

  // ---------------------------------------------------------------- メール
  r.get("/api/admin/mail", "admin", () => ({ status: mailStatus(app) }));

  // 自分のアドレスにテストメールを送る(SMTP の設定を確かめる)
  r.post("/api/admin/mail/test", "admin", async (c) => {
    const me = c.user!;
    if (!mailEnabled(app)) throw new HttpError(409, "サーバーでメール(SMTP)が設定されていません");
    if (!me.email) throw new HttpError(409, "先に「アカウント」で自分のメールアドレスを登録してください");
    try {
      await sendMailOrThrow(app, me.email, "テストメール", `${me.name} さん\n\nメールの設定ができています。このメールに返信する必要はありません。`);
    } catch (e) {
      throw new HttpError(502, `送信できませんでした: ${(e as Error).message}`);
    }
    await app.audit.write({ userId: me.id, userName: me.name, action: "mail_test", interviewId: null, detail: null, ip: c.ip });
    return { ok: true, to: me.email };
  });

  // ---------------------------------------------------------------- 設定
  // 通知先URL(知っていれば誰でもチャンネルに投稿できる)は管理者にだけ見せる
  r.get("/api/settings", "user", (c) => ({
    settings: c.user!.role === "admin" ? store.settings : { ...store.settings, webhookUrl: null },
  }));

  r.put("/api/settings", "admin", async (c) => {
    const body = obj(await readJson(c, 256 * 1024));
    const s = parseSettings(body, store.settings);
    if (s.security.requireTotpForAdmins && !store.settings.security.requireTotpForAdmins && !c.user!.totp) {
      throw new HttpError(409, "先に自分の2段階認証を設定してください(「アカウント」から)");
    }
    s.updatedAt = new Date().toISOString();
    s.updatedBy = c.user!.id;
    store.settings = s;
    await store.saveSettings();
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "settings_update", interviewId: null, detail: null, ip: c.ip });
    return { settings: s };
  });
}

/** ユーザーの追加・変更を1件ずつ行うためのロック(面接IDと重ならない名前) */
const USERS_LOCK = "users:";

function activeAdmins(app: AppContext, excludeId: string): number {
  let n = 0;
  for (const u of app.store.users.values()) if (u.role === "admin" && !u.disabled && u.id !== excludeId) n++;
  return n;
}

const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function parseCriteria(v: unknown, owner: string): Criterion[] {
  const criteria = arr(v, `${owner}の評価項目`, 15, (x, i): Criterion => {
    const o = obj(x, `${owner}の評価項目${i + 1}`);
    return {
      id: typeof o.id === "string" && SHORT_ID_RE.test(o.id) ? o.id : `c${Date.now().toString(36)}${i}`,
      label: str(o.label, `${owner}の評価項目${i + 1}の名前`, { max: 30, min: 1 }),
      description: str(o.description, `${owner}の評価項目${i + 1}の説明`, { max: 200, optional: true }),
      weight: int(o.weight, `${owner}の評価項目${i + 1}の重み`, { min: 1, max: 5, optional: true }) ?? 1,
    };
  });
  if (criteria.length === 0) throw new ValidationError(`${owner}の評価項目を1つ以上設定してください`);
  if (new Set(criteria.map((x) => x.id)).size !== criteria.length) throw new ValidationError(`${owner}の評価項目のIDが重複しています`);
  return criteria;
}

export function parseQuestionPlans(v: unknown, owner: string): QuestionPlan[] {
  return arr(v, `${owner}の質問`, 30, (x, i): QuestionPlan => {
    const o = obj(x, `${owner}の質問${i + 1}`);
    return {
      text: str(o.text, `${owner}の質問${i + 1}`, { max: 100, min: 1 }),
      minutes: int(o.minutes, `${owner}の質問${i + 1}の時間(分)`, { min: 1, max: 120, optional: true }),
    };
  });
}

function parseTemplates(v: unknown): InterviewTemplate[] {
  const templates = arr(v, "評価シート", 20, (x, i): InterviewTemplate => {
    const o = obj(x, `評価シート${i + 1}`);
    const name = str(o.name, `評価シート${i + 1}の名前`, { max: 40, min: 1 });
    const owner = `「${name}」`;
    return {
      id: typeof o.id === "string" && SHORT_ID_RE.test(o.id) ? o.id : `t${Date.now().toString(36)}${i}`,
      name,
      criteria: parseCriteria(o.criteria, owner),
      questions: parseQuestionPlans(o.questions, owner),
      passLine: o.passLine === null || o.passLine === undefined || o.passLine === "" ? null : num(o.passLine, `${owner}の合格の目安`, { min: 1, max: 5 }),
    };
  });
  if (templates.length === 0) throw new ValidationError("評価シートを1つ以上設定してください");
  if (new Set(templates.map((t) => t.id)).size !== templates.length) throw new ValidationError("評価シートのIDが重複しています");
  if (new Set(templates.map((t) => t.name)).size !== templates.length) throw new ValidationError("評価シートの名前が重複しています");
  return templates;
}

export function parseSettings(body: Record<string, unknown>, current: Settings): Settings {
  const templates = parseTemplates(body.templates);
  const defaultTemplateId = typeof body.defaultTemplateId === "string" && templates.some((t) => t.id === body.defaultTemplateId)
    ? body.defaultTemplateId
    : templates[0].id;

  const ratingLabels = arr(body.ratingLabels, "評価の段階", 5, (x, i) => str(x, `評価の段階${i + 1}`, { max: 12, min: 1 }));
  if (ratingLabels.length !== 5) throw new ValidationError("評価の段階は5つ設定してください");

  const consent = obj(body.consent, "同意文");
  const retention = obj(body.retention, "保存期間");
  const recording = obj(body.recording, "録画の画質");
  const bps = int(recording.videoBitsPerSecond, "録画のビットレート", { min: 200_000, max: 8_000_000 })!;
  const preset = RECORDING_PRESETS.find((p) => p.videoBitsPerSecond === bps);

  const webhookRaw = str(body.webhookUrl, "通知先URL", { max: 500, optional: true });
  if (webhookRaw && !isAllowedWebhookUrl(webhookRaw)) throw new ValidationError("通知先URLは https:// で始まるURLにしてください");

  return {
    ...current,
    orgName: str(body.orgName, "団体名", { max: 80, optional: true }),
    contact: str(body.contact, "連絡先", { max: 200, optional: true, multiline: true }),
    templates,
    defaultTemplateId,
    ratingLabels,
    consent: {
      title: str(consent.title, "同意文のタイトル", { max: 100, min: 1 }),
      body: str(consent.body, "同意文", { max: 10_000, min: 20, multiline: true }),
    },
    retention: {
      videoDaysAfterDecision: int(retention.videoDaysAfterDecision, "判定後の録画保存日数", { min: 1, max: 3650 })!,
      videoDaysUndecided: int(retention.videoDaysUndecided, "未判定の録画保存日数", { min: 7, max: 3650 })!,
      attachmentDaysAfterDecision:
        int(retention.attachmentDaysAfterDecision, "判定後の応募書類の保存日数", { min: 1, max: 3650, optional: true }) ??
        current.retention.attachmentDaysAfterDecision,
    },
    blindEvaluation: bool(body.blindEvaluation, "評価の非公開設定"),
    recording: {
      videoBitsPerSecond: bps,
      width: preset?.width ?? int(recording.width, "録画の幅", { min: 320, max: 1920 })!,
      height: preset?.height ?? int(recording.height, "録画の高さ", { min: 240, max: 1080 })!,
    },
    webhookUrl: webhookRaw || null,
    access: {
      interviewerScope:
        body.access === undefined ? current.access.interviewerScope : oneOf(obj(body.access, "閲覧範囲").interviewerScope, "面接官の閲覧範囲", ["all", "assigned"] as const),
    },
    notices: (() => {
      if (body.notices === undefined) return current.notices;
      const n = obj(body.notices, "通知書");
      const one = (k: "pass" | "fail" | "hold", label: string) => {
        const t = obj(n[k], `${label}の通知書`);
        return {
          title: str(t.title, `${label}の通知書のタイトル`, { max: 100, min: 1 }),
          body: str(t.body, `${label}の通知書の本文`, { max: 5000, min: 10, multiline: true }),
        };
      };
      return { pass: one("pass", "合格"), fail: one("fail", "不合格"), hold: one("hold", "保留") };
    })(),
    transcription: {
      enabled:
        body.transcription === undefined ? current.transcription.enabled : bool(obj(body.transcription, "文字起こし").enabled, "文字起こしの設定"),
    },
    security: (() => {
      if (body.security === undefined) return current.security;
      const sec = obj(body.security, "セキュリティ");
      return {
        watermark: bool(sec.watermark, "透かしの設定", current.security.watermark),
        requireTotpForAdmins: bool(sec.requireTotpForAdmins, "管理者の2段階認証", current.security.requireTotpForAdmins),
      };
    })(),
    reminders: (() => {
      if (body.reminders === undefined) return current.reminders;
      const rem = obj(body.reminders, "お知らせ");
      return {
        enabled: bool(rem.enabled, "お知らせの設定", current.reminders.enabled),
        evaluationAfterHours:
          int(rem.evaluationAfterHours, "評価の催促までの時間", { min: 1, max: 24 * 14, optional: true }) ?? current.reminders.evaluationAfterHours,
        dayBeforeHour: int(rem.dayBeforeHour, "前日のお知らせの時刻", { min: 0, max: 23, optional: true }) ?? current.reminders.dayBeforeHour,
      };
    })(),
  };
}
