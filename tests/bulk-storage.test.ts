// 面接のまとめて登録・表の読み取り・ディスクの使用状況のテスト。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeText, parseJstDateTime, parseTable } from "../src/app/csv";
import type { InterviewDetail, StorageUsage } from "../src/shared/types";
import { readyRecording, newInterview, setupTeam, startServer, type Client, type TestServer } from "./helpers/http";

describe("表の読み取り", () => {
  it("CSV(引用符の中の区切り・改行・\"\")とタブ区切りを読む", () => {
    expect(parseTable('表示名,メモ\r\n"山田, 太郎","1行目\n2行目 ""強調"""\r\n\r\n佐藤,\r\n')).toEqual([
      ["表示名", "メモ"],
      ["山田, 太郎", '1行目\n2行目 "強調"'],
      ["佐藤", ""],
    ]);
    expect(parseTable("表示名\t年齢\n山田\t12\n")).toEqual([
      ["表示名", "年齢"],
      ["山田", "12"],
    ]);
  });

  it("UTF-8(BOM つき)と Shift_JIS を読み分ける", () => {
    const utf8 = new TextEncoder().encode("﻿表示名\n山田\n");
    expect(decodeText(utf8.buffer as ArrayBuffer)).toBe("表示名\n山田\n");
    // 「山田」の Shift_JIS
    const sjis = new Uint8Array([0x8e, 0x52, 0x93, 0x63]);
    expect(decodeText(sjis.buffer)).toBe("山田");
  });

  it("日本時間の日時を読む(存在しない日付は読まない)", () => {
    expect(parseJstDateTime("2026/10/12 10:00")).toBe("2026-10-12T01:00:00.000Z");
    expect(parseJstDateTime("2026-1-5 9:30:00")).toBe("2026-01-05T00:30:00.000Z");
    expect(parseJstDateTime("2026年10月12日 10時05分")).toBe("2026-10-12T01:05:00.000Z");
    expect(parseJstDateTime("2026/02/30 10:00")).toBeNull();
    expect(parseJstDateTime("2026/10/12")).toBeNull();
    expect(parseJstDateTime("10:00")).toBeNull();
  });
});

describe("まとめて登録・ディスクの使用状況", () => {
  let server: TestServer;
  let admin: Client;
  let alice: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    server = await startServer();
    ({ admin, alice, ids } = await setupTeam(server));
  });
  afterAll(async () => {
    await server.close();
  });

  it("管理者は面接をまとめて登録できる。1行でも誤りがあれば何も登録しない", async () => {
    const before = (await admin.req("GET", "/api/interviews")).json.interviews.length;
    const row = (name: string, extra: Record<string, unknown> = {}) => ({
      candidate: { displayName: name, kana: "", age: 12, minor: true, note: "" },
      round: "一次面接",
      scheduledAt: "2026-10-20T01:00:00.000Z",
      location: "本校",
      interviewerIds: [ids.alice],
      ...extra,
    });
    expect((await alice.req("POST", "/api/interviews/bulk", { rows: [row("A")] })).status).toBe(403);
    const bad = await admin.req("POST", "/api/interviews/bulk", { rows: [row("A"), row("B", { interviewerIds: ["nobody-xxxxxx"] }), row("", {})] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("2行目");
    expect(bad.json.error).toContain("3行目");
    expect((await admin.req("GET", "/api/interviews")).json.interviews.length).toBe(before);

    const ok = await admin.req("POST", "/api/interviews/bulk", { rows: [row("山田"), row("佐藤", { templateId: "standard", round: "二次面接" })] });
    expect(ok.status).toBe(200);
    expect(ok.json.created).toBe(2);
    const d = (await alice.req("GET", `/api/interviews/${ok.json.ids[1]}`)).json as InterviewDetail;
    expect(d.interview.candidate.displayName).toBe("佐藤");
    expect(d.interview.round).toBe("二次面接");
    expect(d.interview.candidate.minor).toBe(true);
    expect(d.interview.criteria.length).toBeGreaterThan(0);
    expect(d.interview.applicantId).toBe(d.interview.id);
    expect((await admin.req("POST", "/api/interviews/bulk", { rows: [] })).status).toBe(400);
  });

  it("管理者はディスクの使用状況を見られる", async () => {
    const iid = await newInterview(admin, { candidate: { displayName: "容量" } });
    await readyRecording(server, admin, iid, "dev-storage");
    expect((await alice.req("GET", "/api/admin/storage")).status).toBe(403);
    const u = (await admin.req("GET", "/api/admin/storage")).json.usage as StorageUsage;
    expect(u.recordings).toBeGreaterThan(10_000);
    expect(u.records).toBeGreaterThan(0);
    expect(u.free).toBeGreaterThan(0);
    expect(u.total).toBeGreaterThan(u.free!);
  });
});
