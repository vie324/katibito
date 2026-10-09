// 認証・ユーザー・設定の API。

import { APP_VERSION } from "../../src/config/flags";
import { RECORDING_PRESETS } from "../../src/shared/defaults";
import type { Criterion, SessionInfo, Settings } from "../../src/shared/types";
import {
  arr,
  bool,
  int,
  LOGIN_ID_RE,
  obj,
  oneOf,
  password,
  str,
  ValidationError,
} from "../../src/shared/validate";
import { burnPasswordCheck, hashPassword, SESSION_COOKIE, setupCodeMatches, verifyPassword } from "../auth";
import type { AppContext } from "../context";
import { HttpError, readJson, setCookie, type Ctx, type Router } from "../http";
import { isAllowedWebhookUrl } from "../notify";
import { newId, type UserRecord } from "../store";

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

export function registerAccountRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/health", "none", () => ({ ok: true, version: APP_VERSION }));

  r.get("/api/session", "none", (c): SessionInfo => ({
    user: c.user ? store.publicUser(c.user) : null,
    needsSetup: store.users.size === 0,
    orgName: store.settings.orgName,
    version: APP_VERSION,
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
    app.limiter.succeed(c.ip, loginId);
    startSession(app, c, user);
    await app.audit.write({ userId: user.id, userName: user.name, action: "login", interviewId: null, detail: null, ip: c.ip });
    return { user: store.publicUser(user) };
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

  // ---------------------------------------------------------------- ユーザー
  r.get("/api/users", "user", () => ({
    users: [...store.users.values()]
      .map((u) => store.publicUser(u))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));

  r.post("/api/users", "admin", async (c) => {
    const body = obj(await readJson(c));
    const loginId = loginIdOf(body.loginId);
    if (store.userByLogin(loginId)) throw new HttpError(409, "このログインIDは使われています");
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: newId(),
      loginId,
      name: str(body.name, "氏名", { max: 40, min: 1 }),
      role: oneOf(body.role, "権限", ["admin", "interviewer"] as const),
      disabled: false,
      createdAt: now,
      passwordHash: await hashPassword(password(body.password, "初期パスワード")),
      passwordChangedAt: now,
    };
    store.users.set(user.id, user);
    await store.saveUsers();
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "user_create", interviewId: null, detail: `${user.loginId} (${user.role})`, ip: c.ip });
    return { user: store.publicUser(user) };
  });

  r.patch("/api/users/:id", "admin", async (c) => {
    const body = obj(await readJson(c));
    const user = store.users.get(c.params.id);
    if (!user) throw new HttpError(404, "ユーザーが見つかりません");
    const changes: string[] = [];
    if (body.name !== undefined) {
      user.name = str(body.name, "氏名", { max: 40, min: 1 });
      changes.push("name");
    }
    if (body.role !== undefined) {
      const role = oneOf(body.role, "権限", ["admin", "interviewer"] as const);
      if (role !== "admin" && user.role === "admin" && activeAdmins(app, user.id) === 0) {
        throw new HttpError(409, "管理者が1人もいなくなるため変更できません");
      }
      user.role = role;
      changes.push(`role=${role}`);
    }
    if (body.disabled !== undefined) {
      const disabled = bool(body.disabled, "無効化");
      if (disabled && user.id === c.user!.id) throw new HttpError(409, "自分自身は無効にできません");
      if (disabled && user.role === "admin" && activeAdmins(app, user.id) === 0) {
        throw new HttpError(409, "管理者が1人もいなくなるため無効にできません");
      }
      user.disabled = disabled;
      if (disabled) app.sessions.destroyUser(user.id);
      changes.push(disabled ? "disabled" : "enabled");
    }
    if (body.password !== undefined) {
      user.passwordHash = await hashPassword(password(body.password, "新しいパスワード"));
      user.passwordChangedAt = new Date().toISOString();
      app.sessions.destroyUser(user.id);
      changes.push("password");
    }
    await store.saveUsers();
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "user_update", interviewId: null, detail: `${user.loginId}: ${changes.join(", ")}`, ip: c.ip });
    return { user: store.publicUser(user) };
  });

  // ---------------------------------------------------------------- 設定
  r.get("/api/settings", "user", () => ({ settings: store.settings }));

  r.put("/api/settings", "admin", async (c) => {
    const body = obj(await readJson(c, 256 * 1024));
    const s = parseSettings(body, store.settings);
    s.updatedAt = new Date().toISOString();
    s.updatedBy = c.user!.id;
    store.settings = s;
    await store.saveSettings();
    await app.audit.write({ userId: c.user!.id, userName: c.user!.name, action: "settings_update", interviewId: null, detail: null, ip: c.ip });
    return { settings: s };
  });
}

function activeAdmins(app: AppContext, excludeId: string): number {
  let n = 0;
  for (const u of app.store.users.values()) if (u.role === "admin" && !u.disabled && u.id !== excludeId) n++;
  return n;
}

export function parseSettings(body: Record<string, unknown>, current: Settings): Settings {
  const criteria = arr(body.criteria, "評価項目", 15, (x, i): Criterion => {
    const o = obj(x, `評価項目${i + 1}`);
    const id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : `c${Date.now().toString(36)}${i}`;
    return {
      id,
      label: str(o.label, `評価項目${i + 1}の名前`, { max: 30, min: 1 }),
      description: str(o.description, `評価項目${i + 1}の説明`, { max: 200, optional: true }),
    };
  });
  if (criteria.length === 0) throw new ValidationError("評価項目を1つ以上設定してください");
  if (new Set(criteria.map((x) => x.id)).size !== criteria.length) throw new ValidationError("評価項目のIDが重複しています");

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
    criteria,
    ratingLabels,
    defaultQuestions: arr(body.defaultQuestions, "質問リスト", 30, (x, i) => str(x, `質問${i + 1}`, { max: 100, min: 1 })),
    consent: {
      title: str(consent.title, "同意文のタイトル", { max: 100, min: 1 }),
      body: str(consent.body, "同意文", { max: 10_000, min: 20, multiline: true }),
    },
    retention: {
      videoDaysAfterDecision: int(retention.videoDaysAfterDecision, "判定後の録画保存日数", { min: 1, max: 3650 })!,
      videoDaysUndecided: int(retention.videoDaysUndecided, "未判定の録画保存日数", { min: 7, max: 3650 })!,
    },
    blindEvaluation: bool(body.blindEvaluation, "評価の非公開設定"),
    recording: {
      videoBitsPerSecond: bps,
      width: preset?.width ?? int(recording.width, "録画の幅", { min: 320, max: 1920 })!,
      height: preset?.height ?? int(recording.height, "録画の高さ", { min: 240, max: 1080 })!,
    },
    webhookUrl: webhookRaw || null,
  };
}
