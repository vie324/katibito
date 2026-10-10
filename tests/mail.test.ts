// メールのお知らせの結合テスト: テスト用の SMTP サーバーに届いたメールで確かめる。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { MAX_EVALUATION_REMINDERS, runReminders } from "../server/reminders";
import type { UserAccount } from "../src/shared/types";
import { fromDevice, newInterview, RATINGS, readyRecording, setupTeam, startServer, WEBM, type Client, type TestServer } from "./helpers/http";
import { startSmtp, type ReceivedMail } from "./helpers/smtp";

type Smtp = Awaited<ReturnType<typeof startSmtp>>;

async function mailServer(smtp: Smtp): Promise<TestServer> {
  return startServer({
    appUrl: "https://interview.example.jp",
    mail: { ...loadConfig({}).mail, host: "127.0.0.1", port: smtp.port, secure: false, requireTls: false, from: "面接記録 <noreply@example.jp>" },
  });
}

async function withEmails(admin: Client, me: Client, ids: Record<string, string>) {
  expect((await admin.req("PUT", "/api/me/notify", { email: "boss@example.jp" })).status).toBe(200);
  expect((await admin.req("PATCH", `/api/users/${ids.alice}`, { email: "alice@example.jp" })).status).toBe(200);
  expect((await me.req("PUT", "/api/me/notify", { email: "bob@example.jp" })).status).toBe(200);
}

const to = (mails: ReceivedMail[], addr: string) => mails.filter((m) => m.to.includes(addr));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("メールのお知らせ(出来事ごと)", () => {
  let smtp: Smtp;
  let server: TestServer;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    smtp = await startSmtp();
    server = await mailServer(smtp);
    ({ admin, alice, bob, ids } = await setupTeam(server));
    await withEmails(admin, bob, ids);
  });
  afterAll(async () => {
    await server.close();
    await smtp.close();
  });
  afterEach(() => {
    smtp.mails.length = 0;
  });

  it("メールアドレスと受け取る内容は本人と管理者だけが見られる。形式の違うアドレスは受け付けない", async () => {
    const me = (await alice.req("GET", "/api/me")).json.user as UserAccount;
    expect(me.email).toBe("alice@example.jp");
    expect(me.notify).toEqual({ evaluation: true, dayBefore: true, live: false, admin: false });
    expect(((await admin.req("GET", "/api/me")).json.user as UserAccount).notify).toEqual({ evaluation: true, dayBefore: true, live: true, admin: true });
    expect((await alice.req("PUT", "/api/me/notify", { email: "not-an-address" })).status).toBe(400);
    // ほかの人のアドレスは一覧に出ない
    expect((await alice.req("GET", "/api/users")).buf.toString("utf8")).not.toContain("@example.jp");
    expect((await alice.req("GET", "/api/admin/users")).status).toBe(403);
    const list = (await admin.req("GET", "/api/admin/users")).json.users as UserAccount[];
    expect(list.find((u) => u.id === ids.bob)!.email).toBe("bob@example.jp");
    expect((await bob.req("GET", "/api/session")).json.features.mail).toBe(true);
  });

  it("管理者は自分にテストメールを送れる", async () => {
    expect((await alice.req("POST", "/api/admin/mail/test", {})).status).toBe(403);
    const r = await admin.req("POST", "/api/admin/mail/test", {});
    expect(r.status).toBe(200);
    await smtp.waitFor(1);
    const m = smtp.mails[0];
    expect(m.to).toEqual(["boss@example.jp"]);
    expect(m.from).toBe("noreply@example.jp");
    expect(m.subject).toBe("【面接記録】テストメール");
    expect(m.text).toContain("メールの設定ができています");
    expect(m.text).toContain("テスト塾 の面接記録アプリ");
  });

  it("ライブ開始は受け取る設定の人へ(録画している本人を除く)、録画の共有は担当の面接官へ", async () => {
    const iid = await newInterview(alice, { candidate: { displayName: "山田 太郎" }, round: "一次面接", interviewerIds: [ids.alice, ids.bob] });
    const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-mail-live", source: "live", mimeType: "video/webm" });
    const rid = r.json.recording.id;
    expect((await alice.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice("dev-mail-live") })).status).toBe(200);
    expect((await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/live`, { elapsedMs: 3000, question: null }, { headers: fromDevice("dev-mail-live") })).status).toBe(200);
    await smtp.waitFor(1);
    await sleep(100);
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(["boss@example.jp"]);
    expect(smtp.mails[0].subject).toBe("【面接記録】山田 太郎 さん(一次面接)の面接が始まりました(ライブで見られます)");
    expect(smtp.mails[0].text).toContain(`https://interview.example.jp/interviews/${iid}`);
    smtp.mails.length = 0;

    const done = await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice("dev-mail-live") });
    expect(done.status).toBe(200);
    await server.app.ctx.jobs.idle();
    await smtp.waitFor(2);
    await sleep(100);
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(["alice@example.jp", "bob@example.jp"]);
    expect(smtp.mails[0].subject).toContain("録画が共有されました(評価のお願い)");
    // 評価の内容や数値は載せない
    for (const m of smtp.mails) expect(m.text).not.toMatch(/合計点|笑顔/);
  });

  it("評価がそろったら管理者へ、判定が確定したら担当の面接官へ", async () => {
    const iid = await newInterview(admin, { candidate: { displayName: "佐藤 花" }, interviewerIds: [ids.alice, ids.bob] });
    await readyRecording(server, admin, iid, "dev-mail-ready");
    await sleep(100);
    smtp.mails.length = 0;
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: RATINGS, vote: "pass", submit: true })).status).toBe(200);
    await sleep(150);
    expect(smtp.mails).toHaveLength(0);
    expect((await bob.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: RATINGS, vote: "pass", submit: true })).status).toBe(200);
    await smtp.waitFor(1);
    expect(smtp.mails[0].to).toEqual(["boss@example.jp"]);
    expect(smtp.mails[0].subject).toContain("評価がそろいました(判定をお願いします)");
    smtp.mails.length = 0;

    expect((await admin.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "" })).status).toBe(200);
    await smtp.waitFor(2);
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(["alice@example.jp", "bob@example.jp"]);
    expect(smtp.mails[0].text).toContain("「合格」に確定しました");
  });

  it("受け取らない設定の人・その面接を見られない人には送らない", async () => {
    expect((await bob.req("PUT", "/api/me/notify", { notify: { evaluation: false, dayBefore: true, live: true, admin: false } })).status).toBe(200);
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    await admin.req("PUT", "/api/settings", { ...s, access: { interviewerScope: "assigned" } });
    try {
      // bob は評価のお知らせを切っている。alice は担当でない(見られない)のでライブの知らせも届かない
      expect((await alice.req("PUT", "/api/me/notify", { notify: { evaluation: true, dayBefore: true, live: true, admin: false } })).status).toBe(200);
      const iid = await newInterview(admin, { candidate: { displayName: "担当外" }, interviewerIds: [ids.bob] });
      const r = await admin.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-mail-scope", source: "live", mimeType: "video/webm" });
      await admin.req("POST", `/api/interviews/${iid}/recordings/${r.json.recording.id}/live`, { elapsedMs: 1000, question: null }, { headers: fromDevice("dev-mail-scope") });
      await sleep(200);
      // ライブ: 受け取る設定の bob だけ(管理者は録画している本人)
      expect(smtp.mails.map((m) => m.to[0])).toEqual(["bob@example.jp"]);
      smtp.mails.length = 0;
      await admin.req("PUT", `/api/interviews/${iid}/recordings/${r.json.recording.id}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice("dev-mail-scope") });
      await admin.req("POST", `/api/interviews/${iid}/recordings/${r.json.recording.id}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice("dev-mail-scope") });
      await server.app.ctx.jobs.idle();
      await sleep(200);
      expect(smtp.mails).toHaveLength(0);
    } finally {
      const s2 = (await admin.req("GET", "/api/settings")).json.settings;
      await admin.req("PUT", "/api/settings", { ...s2, access: { interviewerScope: "all" } });
      await bob.req("PUT", "/api/me/notify", { notify: { evaluation: true, dayBefore: true, live: false, admin: false } });
      await alice.req("PUT", "/api/me/notify", { notify: { evaluation: true, dayBefore: true, live: false, admin: false } });
    }
  });
});

describe("評価の催促と前日のお知らせ", () => {
  let smtp: Smtp;
  let server: TestServer;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    smtp = await startSmtp();
    server = await mailServer(smtp);
    ({ admin, alice, bob, ids } = await setupTeam(server));
    await withEmails(admin, bob, ids);
  });
  afterAll(async () => {
    await server.close();
    await smtp.close();
  });

  it("録画の共有から決めた時間がたっても未提出なら、24時間おきに最大3回催促する(1人1通にまとめる)", async () => {
    const a = await newInterview(admin, { candidate: { displayName: "催促1" }, interviewerIds: [ids.alice, ids.bob] });
    const b = await newInterview(admin, { candidate: { displayName: "催促2" }, interviewerIds: [ids.alice] });
    await readyRecording(server, admin, a, "dev-remind-a");
    await readyRecording(server, admin, b, "dev-remind-b");
    expect((await bob.req("PUT", `/api/interviews/${a}/evaluations/me`, { ratings: RATINGS, vote: "hold", submit: true })).status).toBe(200);
    await sleep(200);
    smtp.mails.length = 0;

    const H = 3600_000;
    const t0 = Date.now();
    expect(await runReminders(server.app.ctx, t0 + 23 * H)).toEqual({ evaluation: 0, dayBefore: 0 });
    expect((await runReminders(server.app.ctx, t0 + 25 * H)).evaluation).toBe(1);
    await smtp.waitFor(1);
    const m = smtp.mails[0];
    expect(m.to).toEqual(["alice@example.jp"]);
    expect(m.subject).toBe("【面接記録】評価の入力をお願いします(2件)");
    expect(m.text).toContain("催促1");
    expect(m.text).toContain("催促2");
    // 同じ日のうちは送らない
    expect((await runReminders(server.app.ctx, t0 + 30 * H)).evaluation).toBe(0);
    expect((await runReminders(server.app.ctx, t0 + 49 * H)).evaluation).toBe(1);
    // 提出した面接は外れる
    expect((await alice.req("PUT", `/api/interviews/${b}/evaluations/me`, { ratings: RATINGS, vote: "pass", submit: true })).status).toBe(200);
    expect((await runReminders(server.app.ctx, t0 + 73 * H)).evaluation).toBe(1);
    const reminders = to(smtp.mails, "alice@example.jp").filter((x) => x.subject.includes("評価の入力"));
    expect(reminders.map((x) => x.subject)).toEqual([
      "【面接記録】評価の入力をお願いします(2件)",
      "【面接記録】評価の入力をお願いします(2件)",
      "【面接記録】評価の入力をお願いします(1件)",
    ]);
    expect(MAX_EVALUATION_REMINDERS).toBe(3);
    expect((await runReminders(server.app.ctx, t0 + 97 * H)).evaluation).toBe(0);
    // 送った記録はファイルに残す(再起動しても二重に送らない)
    const logFile = path.join(server.dataDir, "notify-log.json");
    expect(existsSync(logFile)).toBe(true);
    expect(JSON.parse(readFileSync(logFile, "utf8"))[`eval:${a}:${ids.alice}`].count).toBe(3);
  });

  it("前日の決めた時刻(日本時間)以降に、翌日の担当の面接を知らせる。日時が変われば知らせ直す", async () => {
    smtp.mails.length = 0;
    const H = 3600_000;
    const jstDate = (ms: number) => new Date(ms + 9 * H).toISOString().slice(0, 10);
    const today = jstDate(Date.now());
    const tomorrow = jstDate(Date.now() + 24 * H);
    const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
    const iid = await newInterview(admin, {
      candidate: { displayName: "明日の人" },
      round: "二次面接",
      location: "本校 2F",
      interviewerIds: [ids.alice, ids.bob],
      scheduledAt: new Date(at(tomorrow, "10:00")).toISOString(),
    });
    expect((await bob.req("PUT", "/api/me/notify", { notify: { evaluation: true, dayBefore: false, live: false, admin: false } })).status).toBe(200);

    expect((await runReminders(server.app.ctx, at(today, "16:30"))).dayBefore).toBe(0);
    expect((await runReminders(server.app.ctx, at(today, "17:05"))).dayBefore).toBe(1);
    await smtp.waitFor(1);
    const m = smtp.mails.find((x) => x.subject.includes("明日"))!;
    expect(m.to).toEqual(["alice@example.jp"]);
    const [, mo, d] = tomorrow.split("-").map(Number);
    expect(m.subject).toBe(`【面接記録】明日(${mo}/${d})の面接のお知らせ(1件)`);
    expect(m.text).toContain("10:00 明日の人 さん(二次面接) 本校 2F");
    expect(m.text).toContain(`https://interview.example.jp/interviews/${iid}`);
    expect((await runReminders(server.app.ctx, at(today, "17:20"))).dayBefore).toBe(0);

    // 時刻を変えたら知らせ直す
    expect((await admin.req("PATCH", `/api/interviews/${iid}`, { scheduledAt: new Date(at(tomorrow, "13:30")).toISOString() })).status).toBe(200);
    expect((await runReminders(server.app.ctx, at(today, "17:35"))).dayBefore).toBe(1);
    // 設定でお知らせを止められる
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    expect((await admin.req("PUT", "/api/settings", { ...s, reminders: { ...s.reminders, enabled: false } })).status).toBe(200);
    expect((await admin.req("PATCH", `/api/interviews/${iid}`, { scheduledAt: new Date(at(tomorrow, "15:00")).toISOString() })).status).toBe(200);
    expect(await runReminders(server.app.ctx, at(today, "17:50"))).toEqual({ evaluation: 0, dayBefore: 0 });
  });
});

describe("メールの設定がないサーバー", () => {
  it("お知らせは送らず、テストメールは理由を返す", async () => {
    const server = await startServer();
    try {
      const { admin } = await setupTeam(server);
      expect((await admin.req("GET", "/api/session")).json.features.mail).toBe(false);
      const r = await admin.req("POST", "/api/admin/mail/test", {});
      expect(r.status).toBe(409);
      expect(r.json.error).toContain("SMTP");
      expect(await runReminders(server.app.ctx)).toEqual({ evaluation: 0, dayBefore: 0 });
    } finally {
      await server.close();
    }
  });
});
