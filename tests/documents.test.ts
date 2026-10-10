// 応募書類の添付と、事前のオンライン同意(保護者向けリンク)の結合テスト。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttachmentMeta, InterviewDetail, InterviewListItem, PublicConsentInfo } from "../src/shared/types";
import { runRetention } from "../server/retention";
import { Client, newInterview, setupTeam, startServer, type TestServer } from "./helpers/http";

let server: TestServer;
let admin: Client;
let alice: Client;
let bob: Client;
let ids: Record<string, string>;

beforeAll(async () => {
  server = await startServer();
  ({ admin, alice, bob, ids } = await setupTeam(server));
});

afterAll(async () => {
  await server.close();
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function upload(c: Client, iid: string, body: Buffer, name: string, label = "") {
  return c.req("POST", `/api/interviews/${iid}/attachments?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label)}`, undefined, {
    raw: body,
  });
}

async function plainInterview(body: Record<string, unknown> = {}): Promise<string> {
  const r = await admin.req("POST", "/api/interviews", { candidate: { displayName: "書類の人" }, interviewerIds: [ids.alice, ids.bob], ...body });
  expect(r.status).toBe(200);
  return r.json.interview.id;
}

describe("応募書類の添付", () => {
  it("PDF・画像を添付でき、形式は中身(先頭のバイト)で判定する", async () => {
    const iid = await plainInterview();
    const a = await upload(alice, iid, PDF, "願書 山田.pdf", "願書");
    expect(a.status).toBe(200);
    const meta = a.json.attachment as AttachmentMeta;
    expect(meta).toMatchObject({ name: "願書 山田.pdf", label: "願書", mime: "application/pdf", sizeBytes: PDF.length, uploadedBy: ids.alice });

    // 拡張子が画像でも、中身が PNG なら PNG として扱う。名前のパスは取り除く
    const p = await upload(bob, iid, PNG, "../../作文.jpg");
    expect(p.status).toBe(200);
    expect(p.json.attachment.mime).toBe("image/png");
    expect(p.json.attachment.name).toBe("作文.jpg");

    // 中身が HTML なら、名前が .pdf でも受け付けない
    expect((await upload(alice, iid, Buffer.from("<html><script>alert(1)</script></html>"), "x.pdf")).status).toBe(415);
    expect((await upload(alice, iid, Buffer.alloc(0), "empty.pdf")).status).toBe(400);
    expect((await upload(alice, iid, Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]), "big.pdf")).status).toBe(413);

    const d = (await bob.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.attachments.map((x) => x.name)).toEqual(["願書 山田.pdf", "作文.jpg"]);

    // 見る: 画面に表示(inline)、?download=1 なら保存
    const got = await bob.req("GET", `/api/interviews/${iid}/attachments/${meta.id}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("application/pdf");
    expect(String(got.headers["content-disposition"])).toMatch(/^inline;/);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(got.buf, PDF)).toBe(0);
    const dl = await bob.req("GET", `/api/interviews/${iid}/attachments/${meta.id}?download=1`);
    expect(String(dl.headers["content-disposition"])).toMatch(/^attachment;/);
    // ログインしていなければ見られない
    expect((await new Client(() => server.base).req("GET", `/api/interviews/${iid}/attachments/${meta.id}`)).status).toBe(401);
  });

  it("削除は添付した本人か管理者だけ。ファイルも消える", async () => {
    const iid = await plainInterview();
    const a = (await upload(alice, iid, PDF, "a.pdf")).json.attachment as AttachmentMeta;
    const file = path.join(server.dataDir, "interviews", iid, "attachments", `${a.id}.pdf`);
    expect(existsSync(file)).toBe(true);
    expect((await bob.req("DELETE", `/api/interviews/${iid}/attachments/${a.id}`)).status).toBe(403);
    const del = await admin.req("DELETE", `/api/interviews/${iid}/attachments/${a.id}`);
    expect(del.status).toBe(200);
    expect(del.json.attachments).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect((await bob.req("GET", `/api/interviews/${iid}/attachments/${a.id}`)).status).toBe(404);
  });

  it("1つの面接に添付できるのは 20 件まで", async () => {
    const iid = await plainInterview();
    for (let i = 0; i < 20; i++) expect((await upload(alice, iid, PNG, `p${i}.png`)).status).toBe(200);
    expect((await upload(alice, iid, PNG, "over.png")).status).toBe(409);
  });

  it("担当でない面接の書類は(閲覧範囲を「担当だけ」にすると)見られない", async () => {
    const iid = await plainInterview({ interviewerIds: [ids.bob] });
    const a = (await upload(bob, iid, PDF, "b.pdf")).json.attachment as AttachmentMeta;
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    await admin.req("PUT", "/api/settings", { ...s, access: { interviewerScope: "assigned" } });
    try {
      expect((await alice.req("GET", `/api/interviews/${iid}/attachments/${a.id}`)).status).toBe(404);
      expect((await upload(alice, iid, PDF, "c.pdf")).status).toBe(404);
      expect((await bob.req("GET", `/api/interviews/${iid}/attachments/${a.id}`)).status).toBe(200);
    } finally {
      const s2 = (await admin.req("GET", "/api/settings")).json.settings;
      await admin.req("PUT", "/api/settings", { ...s2, access: { interviewerScope: "all" } });
    }
  });

  it("判定から保存期間を過ぎると、添付ファイルは自動で消える", async () => {
    const iid = await plainInterview();
    await upload(alice, iid, PDF, "old.pdf");
    expect((await admin.req("PUT", `/api/interviews/${iid}/decision`, { result: "fail", reason: "" })).status).toBe(200);
    const days = (await admin.req("GET", "/api/settings")).json.settings.retention.attachmentDaysAfterDecision;
    expect(days).toBe(365);
    const early = await runRetention(server.app.ctx, Date.now() + (days - 1) * 86_400_000);
    expect(early.attachmentsPurged).toBe(0);
    const late = await runRetention(server.app.ctx, Date.now() + (days + 1) * 86_400_000);
    expect(late.attachmentsPurged).toBeGreaterThanOrEqual(1);
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.attachments).toEqual([]);
    expect(existsSync(path.join(server.dataDir, "interviews", iid, "attachments"))).toBe(false);
  });

  it("判定のあとに添付した書類は、添付した日から保存期間を数える", async () => {
    const iid = await plainInterview();
    const before = (await upload(alice, iid, PDF, "before.pdf")).json.attachment as AttachmentMeta;
    expect((await admin.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "" })).status).toBe(200);
    const days = 365;
    // 判定から日数がたってから添付した、という状態にする(添付の日時を後ろにずらす)
    const later = (await upload(alice, iid, PDF, "later.pdf")).json.attachment as AttachmentMeta;
    const iv = server.app.ctx.store.interviews.get(iid)!;
    iv.attachments.find((a) => a.id === later.id)!.uploadedAt = new Date(Date.now() + 300 * 86_400_000).toISOString();
    const r = await runRetention(server.app.ctx, Date.now() + (days + 1) * 86_400_000);
    expect(r.attachmentsPurged).toBeGreaterThanOrEqual(1);
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.attachments.map((a) => a.id)).toEqual([later.id]);
    expect(existsSync(path.join(server.dataDir, "interviews", iid, "attachments", `${before.id}.pdf`))).toBe(false);
    expect(existsSync(path.join(server.dataDir, "interviews", iid, "attachments", `${later.id}.pdf`))).toBe(true);
  });
});

describe("事前のオンライン同意", () => {
  const pub = () => new Client(() => server.base);

  async function linkFor(iid: string, c: Client = alice, days?: number): Promise<{ token: string; detail: InterviewDetail }> {
    const r = await c.req("POST", `/api/interviews/${iid}/consent-links`, days ? { days } : {});
    expect(r.status).toBe(200);
    return { token: r.json.token, detail: r.json.detail };
  }

  it("リンクを作るとトークンを1度だけ返し、サーバーにはハッシュだけを保存する(応答にも出さない)", async () => {
    const iid = await plainInterview({ candidate: { displayName: "山田 太郎", age: 11 }, scheduledAt: "2026-10-20T01:00:00.000Z" });
    const { token, detail } = await linkFor(iid);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(detail.interview.consentLinks).toHaveLength(1);
    expect(detail.interview.consentLinks[0].tokenHash).toBe("");
    const stored = server.app.ctx.store.interviews.get(iid)!.consentLinks[0];
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    const view = (await bob.req("GET", `/api/interviews/${iid}`)).buf.toString("utf8");
    expect(view).not.toContain(stored.tokenHash);
    expect(view).not.toContain(token);

    const info = (await pub().req("GET", `/api/public/consent/${token}`)).json as PublicConsentInfo;
    expect(info.state).toBe("open");
    expect(info.details!.candidateName).toBe("山田 太郎");
    expect(info.details!.minor).toBe(true);
    expect(info.orgName).toBe("テスト塾");
    expect(info.details!.consent.title.length).toBeGreaterThan(0);
    expect(info.details!.consent.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it("本人・保護者が入力すると、オンラインの同意として記録され、リンクは使用済みになる", async () => {
    const iid = await plainInterview({ candidate: { displayName: "佐藤 花", age: 12 } });
    const { token } = await linkFor(iid);
    const p = pub();
    const info = (await p.req("GET", `/api/public/consent/${token}`)).json as PublicConsentInfo;
    const body = { recording: true, analysis: false, candidateName: "佐藤 花", guardianName: "佐藤 一郎", guardianRelation: "父", consentVersion: info.details!.consent.version };

    // 未成年は保護者の名前が必要
    expect((await p.req("POST", `/api/public/consent/${token}`, { ...body, guardianName: "" })).status).toBe(400);
    // 計測だけの同意はできない
    expect((await p.req("POST", `/api/public/consent/${token}`, { ...body, recording: false, analysis: true })).status).toBe(400);
    // 表示した文面と版が違えば受け付けない
    expect((await p.req("POST", `/api/public/consent/${token}`, { ...body, consentVersion: "000000000000" })).status).toBe(409);
    // クロスサイトからの送信は受け付けない
    expect((await p.req("POST", `/api/public/consent/${token}`, body, { headers: { "X-Requested-With": "" } })).status).toBe(403);

    const ok = await p.req("POST", `/api/public/consent/${token}`, body);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, recording: true, analysis: false });

    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.consent).toMatchObject({
      recording: true,
      analysis: false,
      method: "online",
      candidateName: "佐藤 花",
      guardianName: "佐藤 一郎",
      guardianRelation: "父",
      obtainedBy: ids.alice,
      consentVersion: info.details!.consent.version,
    });
    expect(d.interview.consent!.linkId).toBe(d.interview.consentLinks[0].id);
    expect(d.interview.consentLinks[0].usedAt).not.toBeNull();

    // 2回目は受け付けない。状態は「済み」
    expect((await p.req("POST", `/api/public/consent/${token}`, body)).status).toBe(409);
    const doneInfo = (await p.req("GET", `/api/public/consent/${token}`)).json as PublicConsentInfo;
    expect(doneInfo.state).toBe("done");
    expect(doneInfo.details).toBeNull();
    expect(JSON.stringify(doneInfo)).not.toContain("佐藤 花");
    // 同意が記録された面接には、新しいリンクを作れない
    expect((await alice.req("POST", `/api/interviews/${iid}/consent-links`, {})).status).toBe(409);
    // 操作ログに残る
    const audit = (await admin.req("GET", "/api/audit")).json.entries as { action: string; interviewId: string | null; ip: string | null }[];
    const entry = audit.find((e) => e.action === "consent_online" && e.interviewId === iid);
    expect(entry?.ip).toBeTruthy();
  });

  it("同意しない回答も記録する(録画せずに面接)", async () => {
    const iid = await plainInterview({ candidate: { displayName: "大人の人", age: 20 } });
    const { token } = await linkFor(iid);
    const info = (await pub().req("GET", `/api/public/consent/${token}`)).json as PublicConsentInfo;
    expect(info.details!.minor).toBe(false);
    const r = await pub().req("POST", `/api/public/consent/${token}`, {
      recording: false,
      analysis: false,
      candidateName: "大人の人",
      consentVersion: info.details!.consent.version,
    });
    expect(r.status).toBe(200);
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.consent!.recording).toBe(false);
    expect(d.interview.recordingDeclined).toBe(true);
  });

  it("事前に録画を断られても、予定日時までは「録画前」のまま(面接の前に評価を求めない)", async () => {
    const iid = await plainInterview({
      candidate: { displayName: "これからの人", age: 20 },
      scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    const { token } = await linkFor(iid);
    const info = (await pub().req("GET", `/api/public/consent/${token}`)).json as PublicConsentInfo;
    const r = await pub().req("POST", `/api/public/consent/${token}`, {
      recording: false,
      analysis: false,
      candidateName: "これからの人",
      consentVersion: info.details!.consent.version,
    });
    expect(r.status).toBe(200);
    const statusOf = async () => ((await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[]).find((x) => x.id === iid)!;
    expect((await statusOf()).status).toBe("scheduled");
    expect((await statusOf()).consent!.method).toBe("online");
    expect(((await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail).status).toBe("scheduled");
    // 予定日時を過ぎれば、録画なしで行った面接として評価に進む
    expect((await admin.req("PATCH", `/api/interviews/${iid}`, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).status).toBe(200);
    expect((await statusOf()).status).toBe("evaluating");
  });

  it("取り消したリンク・期限切れのリンク・判定済みの面接のリンクは使えない", async () => {
    const iid = await plainInterview();
    const first = await linkFor(iid);
    const second = await linkFor(iid, bob, 3);
    const lid = first.detail.interview.consentLinks[0].id;
    expect((await alice.req("DELETE", `/api/interviews/${iid}/consent-links/${lid}`)).status).toBe(200);
    const revoked = (await pub().req("GET", `/api/public/consent/${first.token}`)).json as PublicConsentInfo;
    expect(revoked.state).toBe("revoked");
    // 取り消したリンクでは、候補者の名前や面接の日時・場所を返さない
    expect(revoked.details).toBeNull();
    expect(JSON.stringify(revoked)).not.toContain("書類の人");
    const info = (await pub().req("GET", `/api/public/consent/${second.token}`)).json as PublicConsentInfo;
    expect(info.state).toBe("open");
    expect(Date.parse(info.details!.expiresAt) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);

    // 期限切れ
    const stored = server.app.ctx.store.interviews.get(iid)!.consentLinks.find((l) => l.createdBy === ids.bob)!;
    const saved = stored.expiresAt;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(((await pub().req("GET", `/api/public/consent/${second.token}`)).json as PublicConsentInfo).state).toBe("expired");
    const body = { recording: true, analysis: true, candidateName: "x", consentVersion: info.details!.consent.version };
    expect((await pub().req("POST", `/api/public/consent/${second.token}`, body)).status).toBe(409);
    stored.expiresAt = saved;

    // 判定済み
    expect((await admin.req("PUT", `/api/interviews/${iid}/decision`, { result: "hold", reason: "" })).status).toBe(200);
    expect(((await pub().req("GET", `/api/public/consent/${second.token}`)).json as PublicConsentInfo).state).toBe("expired");
    expect((await alice.req("POST", `/api/interviews/${iid}/consent-links`, {})).status).toBe(409);
  });

  // 接続元ごとの失敗回数で止めるため、このテストは最後に置く
  it("間違ったトークンを続けて送る接続元は、一時的に止める", async () => {
    const iid = await plainInterview();
    const { token } = await linkFor(iid);
    expect((await pub().req("GET", `/api/public/consent/short`)).status).toBe(404);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await pub().req("GET", `/api/public/consent/${"A".repeat(43)}`)).status;
    expect(last).toBe(429);
    // 止まっている間は、正しいトークンでも受け付けない(総当たりの手がかりを与えない)
    expect((await pub().req("GET", `/api/public/consent/${token}`)).status).toBe(429);
    await newInterview(admin, { candidate: { displayName: "後片付け" } });
  });
});
