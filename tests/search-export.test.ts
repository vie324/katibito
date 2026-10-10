// 横断検索と、候補者のデータの書き出し(ZIP)の結合テスト。

import { writeFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchResult } from "../src/shared/types";
import { newInterview, RATINGS, readyRecording, setupTeam, startServer, type Client, type TestServer } from "./helpers/http";

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

const search = async (c: Client, q: string) => (await c.req("GET", `/api/search?q=${encodeURIComponent(q)}`)).json.results as SearchResult[];

/** ZIP を読む(テスト用): 中央ディレクトリからファイルを取り出し、CRC を確かめる */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    expect(flags & 0x0800).toBe(0x0800);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    // データ記述子
    expect(buf.readUInt32LE(start + size)).toBe(0x08074b50);
    expect(buf.readUInt32LE(start + size + 4)).toBe(crc);
    files.set(name, Buffer.from(data));
    p += 46 + nameLen;
  }
  return files;
}

describe("横断検索", () => {
  let iid = "";
  let rid = "";

  it("候補者の情報・メモ・評価のコメント・文字起こしから探せる。非公開のうちはほかの人のメモ・評価は探さない", async () => {
    iid = await newInterview(admin, { candidate: { displayName: "山田 太郎", kana: "やまだ たろう" }, round: "一次面接", interviewerIds: [ids.alice, ids.bob] });
    rid = await readyRecording(server, admin, iid, "dev-search");
    expect((await alice.req("POST", `/api/interviews/${iid}/notes`, { recordingId: rid, tMs: 12_000, text: "受け答えがとてもはっきりしていた" })).status).toBe(200);
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: RATINGS, vote: "pass", comment: "将来の目標が具体的だった", submit: true })).status).toBe(200);
    // 文字起こし(サーバーで作られたものとして置く)
    writeFileSync(
      path.join(server.dataDir, "interviews", iid, "recordings", rid, "transcript.json"),
      JSON.stringify({ language: "ja", model: "test", createdAt: new Date().toISOString(), segments: [{ startMs: 65_000, endMs: 69_000, text: "夏休みにマレーシアへ行きました" }] }),
    );
    server.app.ctx.store.interviews.get(iid)!.recordings[0].transcript = "ready";

    const byName = await search(bob, "やまだ");
    expect(byName.map((r) => r.interviewId)).toEqual([iid]);
    expect(byName[0].hits[0].kind).toBe("candidate");

    const tr = await search(bob, "マレーシア");
    expect(tr[0].hits[0]).toMatchObject({ kind: "transcript", recordingId: rid, tMs: 65_000 });
    expect(tr[0].hits[0].text).toContain("マレーシア");

    // bob はまだ評価を出していないので、alice のメモ・評価は探さない
    expect(await search(bob, "はっきり")).toEqual([]);
    expect(await search(bob, "目標")).toEqual([]);
    // 書いた本人は探せる
    expect((await search(alice, "はっきり"))[0].hits[0]).toMatchObject({ kind: "note", recordingId: rid, tMs: 12_000, who: "面接官A" });
    // 管理者も、自分の評価を出す前は画面と同じく伏せる
    expect(await search(admin, "目標")).toEqual([]);

    expect((await bob.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: RATINGS, vote: "hold", submit: true })).status).toBe(200);
    expect((await search(bob, "はっきり"))[0].hits[0].kind).toBe("note");
    expect((await search(bob, "目標"))[0].hits[0]).toMatchObject({ kind: "evaluation", who: "面接官A" });
  });

  it("見られない面接は探さない。検索は操作ログに残る", async () => {
    const other = await newInterview(admin, { candidate: { displayName: "担当外の人" }, interviewerIds: [ids.bob] });
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    await admin.req("PUT", "/api/settings", { ...s, access: { interviewerScope: "assigned" } });
    try {
      expect(await search(alice, "担当外")).toEqual([]);
      expect((await search(bob, "担当外")).map((r) => r.interviewId)).toEqual([other]);
    } finally {
      const s2 = (await admin.req("GET", "/api/settings")).json.settings;
      await admin.req("PUT", "/api/settings", { ...s2, access: { interviewerScope: "all" } });
    }
    expect((await alice.req("GET", "/api/search?q=")).status).toBe(400);
    const audit = (await admin.req("GET", "/api/audit")).json.entries as { action: string; detail: string | null }[];
    expect(audit.some((e) => e.action === "search" && e.detail === "担当外")).toBe(true);
  });

  it("候補者のデータを ZIP で書き出せる(管理者)。同じ候補者のほかの面接も含められる", async () => {
    const next = await alice.req("POST", "/api/interviews", { candidate: { displayName: "山田 太郎" }, round: "二次面接", fromInterviewId: iid });
    expect(next.status).toBe(200);
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    expect(
      (await admin.req("POST", `/api/interviews/${iid}/attachments?name=${encodeURIComponent("願書.pdf")}&label=${encodeURIComponent("願書")}`, undefined, { raw: pdf })).status,
    ).toBe(200);
    expect((await admin.req("POST", `/api/interviews/${next.json.interview.id}/consent-links`, {})).status).toBe(200);

    expect((await alice.req("GET", `/api/interviews/${iid}/export.zip`)).status).toBe(403);
    const one = await admin.req("GET", `/api/interviews/${iid}/export.zip`);
    expect(one.status).toBe(200);
    expect(one.headers["content-type"]).toBe("application/zip");
    expect(decodeURIComponent(String(one.headers["content-disposition"]))).toContain("山田 太郎_");
    const files = readZip(one.buf);
    const names = [...files.keys()];
    const root = names[0].split("/")[0];
    expect(names).toEqual(
      expect.arrayContaining([
        `${root}/はじめにお読みください.txt`,
        expect.stringMatching(/\/01_一次面接_\d{8}\/interview\.json$/),
        expect.stringMatching(/\/01_一次面接_\d{8}\/同意\.txt$/),
        expect.stringMatching(/\/01_一次面接_\d{8}\/evaluations\.json$/),
        expect.stringMatching(/\/01_一次面接_\d{8}\/notes\.json$/),
        expect.stringMatching(/\/recordings\/01_録画\.webm$/),
        expect.stringMatching(/\/recordings\/01_文字起こし\.txt$/),
        expect.stringMatching(/\/応募書類\/願書_願書\.pdf$/),
      ]),
    );
    expect(names.some((n) => n.includes("二次面接"))).toBe(false);
    const text = (suffix: string) => files.get(names.find((n) => n.endsWith(suffix))!)!.toString("utf8");
    expect(text("文字起こし.txt")).toBe("[1:05] 夏休みにマレーシアへ行きました\n");
    expect(JSON.parse(text("evaluations.json"))).toHaveLength(2);
    // 端末の録画ID(送信の合言葉)は含めない
    const ivJson = JSON.parse(text("interview.json"));
    expect(ivJson.recordings[0].clientId).toBe("");
    expect(text("interview.json")).not.toContain("dev-search");
    expect(files.get(names.find((n) => n.endsWith("願書_願書.pdf"))!)!.equals(pdf)).toBe(true);

    const both = readZip((await admin.req("GET", `/api/interviews/${iid}/export.zip?scope=applicant`)).buf);
    const bothNames = [...both.keys()];
    expect(bothNames.some((n) => /\/02_二次面接_\d{8}\/interview\.json$/.test(n))).toBe(true);
    // 同意のリンクのハッシュは含めない
    const second = both.get(bothNames.find((n) => /\/02_二次面接_\d{8}\/interview\.json$/.test(n))!)!.toString("utf8");
    const stored = server.app.ctx.store.interviews.get(next.json.interview.id)!.consentLinks[0].tokenHash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toContain(stored);

    const audit = (await admin.req("GET", "/api/audit")).json.entries as { action: string; detail: string | null }[];
    expect(audit.some((e) => e.action === "interview_export" && e.detail?.startsWith("applicant n=2"))).toBe(true);
  });
});
