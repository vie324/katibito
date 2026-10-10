// 2段階認証(TOTP)のテスト: 計算(RFC 6238 の試験値)と、設定・ログイン・予備のコード・管理者への必須化・解除。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hashRecovery, newRecoveryCodes, STEP_MS, totpAt, verifyTotp } from "../server/totp";
import type { SessionInfo, UserAccount } from "../src/shared/types";
import { Client, setupTeam, startServer, type TestServer } from "./helpers/http";

describe("TOTP の計算", () => {
  it("RFC 6238 の試験値と一致する(SHA1・8桁)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, want] of vectors) expect(totpAt(secret, Math.floor(t / 30), 8)).toBe(want);
  });

  it("前後1刻みまで受け付け、使った刻み以前のコードは使い回せない", () => {
    const secret = base32Encode(Buffer.from("abcdefghijabcdefghij"));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / STEP_MS);
    expect(verifyTotp(secret, totpAt(secret, step), -1, now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), -1, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), -1, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), -1, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, "12a456", -1, now)).toBeNull();
  });

  it("予備のコードは読み間違えにくい文字で xxxx-xxxx、区切りや大文字小文字は問わない", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    expect(hashRecovery(codes[0].toUpperCase().replace("-", " "))).toBe(hashRecovery(codes[0]));
  });
});

describe("2段階認証の設定とログイン", () => {
  let server: TestServer;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let ids: Record<string, string>;
  let aliceSecret = "";
  let aliceRecovery: string[] = [];
  const cur = () => Math.floor(Date.now() / STEP_MS);
  const fresh = () => new Client(() => server.base);

  beforeAll(async () => {
    server = await startServer();
    ({ admin, alice, bob, ids } = await setupTeam(server));
  });
  afterAll(async () => {
    await server.close();
  });

  it("設定: 鍵を作り、確認コードが合えば有効にして予備のコードを返す。ほかの端末のログインは解除する", async () => {
    expect((await alice.req("GET", "/api/me/totp")).json).toEqual({ enabled: false, enabledAt: null, recoveryRemaining: 0 });
    const other = fresh();
    expect((await other.login("alice", "password-123")).status).toBe(200);

    const setup = await alice.req("POST", "/api/me/totp/setup", {});
    expect(setup.status).toBe(200);
    aliceSecret = setup.json.secret;
    expect(aliceSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.json.uri).toBe(`otpauth://totp/${encodeURIComponent("面接記録(テスト塾):alice")}?secret=${aliceSecret}&issuer=${encodeURIComponent("面接記録(テスト塾)")}&algorithm=SHA1&digits=6&period=30`);

    expect((await alice.req("POST", "/api/me/totp/enable", { code: "000000" })).status).toBe(400);
    const en = await alice.req("POST", "/api/me/totp/enable", { code: totpAt(aliceSecret, cur()) });
    expect(en.status).toBe(200);
    aliceRecovery = en.json.recoveryCodes;
    expect(aliceRecovery).toHaveLength(10);
    expect((await alice.req("GET", "/api/me/totp")).json).toMatchObject({ enabled: true, recoveryRemaining: 10 });
    // この端末はそのまま、ほかの端末はログインし直し
    expect((await alice.req("GET", "/api/interviews")).status).toBe(200);
    expect((await other.req("GET", "/api/interviews")).status).toBe(401);
    // 鍵は応答に出さない
    expect(JSON.stringify((await admin.req("GET", "/api/admin/users")).json)).not.toContain(aliceSecret);
    expect(((await admin.req("GET", "/api/admin/users")).json.users as UserAccount[]).find((u) => u.id === ids.alice)!.totpEnabled).toBe(true);
  });

  it("ログイン: パスワードのあとに確認コードが必要。同じ刻みのコードの使い回しはできない", async () => {
    const c = fresh();
    const first = await c.login("alice", "password-123");
    expect(first.status).toBe(200);
    expect(first.json.totpRequired).toBe(true);
    expect(first.json.user).toBeUndefined();
    expect(c.cookie).toBe("");
    expect(((await c.req("GET", "/api/session")).json as SessionInfo).user).toBeNull();

    // 有効にしたときの刻みのコードは使えない(使い回し防止)
    expect((await c.req("POST", "/api/login/totp", { ticket: first.json.ticket, code: totpAt(aliceSecret, cur() - 1) })).status).toBe(401);
    const ok = await c.req("POST", "/api/login/totp", { ticket: first.json.ticket, code: totpAt(aliceSecret, cur() + 1) });
    expect(ok.status).toBe(200);
    expect(ok.json.user.id).toBe(ids.alice);
    expect((await c.req("GET", "/api/interviews")).status).toBe(200);
    // 合言葉は1回だけ
    expect((await fresh().req("POST", "/api/login/totp", { ticket: first.json.ticket, code: totpAt(aliceSecret, cur() + 1) })).status).toBe(401);
  });

  it("予備のコードでもログインでき、使ったコードはもう使えない", async () => {
    const c = fresh();
    const t1 = (await c.login("alice", "password-123")).json.ticket;
    const r = await c.req("POST", "/api/login/totp", { ticket: t1, code: aliceRecovery[0].toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.json.recoveryRemaining).toBe(9);
    const c2 = fresh();
    const t2 = (await c2.login("alice", "password-123")).json.ticket;
    expect((await c2.req("POST", "/api/login/totp", { ticket: t2, code: aliceRecovery[0] })).status).toBe(401);
    const audit = (await admin.req("GET", "/api/audit")).json.entries as { action: string; detail: string | null; userId: string | null }[];
    expect(audit.some((e) => e.action === "login" && e.detail === "予備のコード" && e.userId === ids.alice)).toBe(true);
  });

  it("確認コードを5回まちがえると、パスワードから入れ直し", async () => {
    const setup = await bob.req("POST", "/api/me/totp/setup", {});
    expect((await bob.req("POST", "/api/me/totp/enable", { code: totpAt(setup.json.secret, cur()) })).status).toBe(200);
    const c = fresh();
    const ticket = (await c.login("bob", "password-123")).json.ticket;
    for (let i = 0; i < 4; i++) expect((await c.req("POST", "/api/login/totp", { ticket, code: "000000" })).json.error).toBe("確認コードが違います");
    expect((await c.req("POST", "/api/login/totp", { ticket, code: "000000" })).json.error).toContain("もう一度ログイン");
    expect((await c.req("POST", "/api/login/totp", { ticket, code: totpAt(setup.json.secret, cur() + 1) })).status).toBe(401);
  });

  it("管理者への必須化: 自分が未設定ならオンにできない。オンのあと未設定の管理者は設定するまでほかの操作ができない", async () => {
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    const on = { ...s, security: { ...s.security, requireTotpForAdmins: true } };
    expect((await admin.req("PUT", "/api/settings", on)).status).toBe(409);
    const setup = await admin.req("POST", "/api/me/totp/setup", {});
    expect((await admin.req("POST", "/api/me/totp/enable", { code: totpAt(setup.json.secret, cur()) })).status).toBe(200);
    expect((await admin.req("PUT", "/api/settings", on)).status).toBe(200);
    // 必須のあいだは自分の2段階認証を無効にできない
    expect((await admin.req("POST", "/api/me/totp/disable", { password: "password-123" })).status).toBe(409);

    expect((await admin.req("POST", "/api/users", { loginId: "boss2", name: "副代表", role: "admin", password: "password-456" })).status).toBe(200);
    const boss2 = fresh();
    expect((await boss2.login("boss2", "password-456")).json.user.id).toBeTruthy();
    expect(((await boss2.req("GET", "/api/session")).json as SessionInfo).mustSetupTotp).toBe(true);
    const blocked = await boss2.req("GET", "/api/interviews");
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toContain("2段階認証");
    expect((await boss2.req("GET", "/api/me")).status).toBe(200);
    const s2 = await boss2.req("POST", "/api/me/totp/setup", {});
    expect((await boss2.req("POST", "/api/me/totp/enable", { code: totpAt(s2.json.secret, cur()) })).status).toBe(200);
    expect(((await boss2.req("GET", "/api/session")).json as SessionInfo).mustSetupTotp).toBe(false);
    expect((await boss2.req("GET", "/api/interviews")).status).toBe(200);
    // 面接官には必須ではない
    expect(((await fresh().req("GET", "/api/session")).json as SessionInfo).mustSetupTotp).toBe(false);
  });

  it("管理者はスマートフォンをなくした人の2段階認証を解除できる(その人のログインも解除)", async () => {
    expect((await alice.req("POST", `/api/users/${ids.bob}/totp/reset`, {})).status).toBe(403);
    const r = await admin.req("POST", `/api/users/${ids.alice}/totp/reset`, {});
    expect(r.status).toBe(200);
    expect((r.json.user as UserAccount).totpEnabled).toBe(false);
    expect((await alice.req("GET", "/api/interviews")).status).toBe(401);
    const c = fresh();
    const l = await c.login("alice", "password-123");
    expect(l.json.user.id).toBe(ids.alice);
    // 本人は自分で無効にもできる(パスワードが必要)
    expect((await c.req("POST", "/api/me/totp/setup", {})).status).toBe(200);
    expect((await bob.req("POST", "/api/me/totp/disable", { password: "wrong-password" })).status).toBe(400);
  });
});
