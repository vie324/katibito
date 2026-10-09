// v0.3 の機能の結合テスト: 評価シート(テンプレート)・重み付き合計点・同じ候補者の面接・閲覧範囲 ほか。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weightedScore } from "../src/shared/score";
import type { InterviewDetail, InterviewListItem, Settings } from "../src/shared/types";
import { Store, mergeSettings } from "../server/store";
import { newInterview, RATINGS, setupTeam, startServer, type Client, type TestServer } from "./helpers/http";

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

async function settings(): Promise<Settings> {
  return (await admin.req("GET", "/api/settings")).json.settings as Settings;
}

describe("評価シート(テンプレート)と重み付き合計点", () => {
  it("初期設定では「標準」の評価シートが1つあり、面接はその評価項目の写しを持つ", async () => {
    const s = await settings();
    expect(s.templates).toHaveLength(1);
    expect(s.templates[0].name).toBe("標準");
    expect(s.templates[0].criteria.every((c) => c.weight === 1)).toBe(true);
    const r = await alice.req("POST", "/api/interviews", { candidate: { displayName: "標準の人" } });
    const iv = (r.json as InterviewDetail).interview;
    expect(iv.templateId).toBe(s.defaultTemplateId);
    expect(iv.criteria.map((c) => c.id)).toEqual(s.templates[0].criteria.map((c) => c.id));
    expect(iv.questions).toEqual(s.templates[0].questions.map((q) => q.text));
    expect(iv.questionMinutes).toEqual(s.templates[0].questions.map((q) => q.minutes));
  });

  it("評価シートを追加でき、面接ごとに選べる。あとで評価シートを変えても登録済みの面接は変わらない", async () => {
    const s = await settings();
    const sports = {
      id: "sports",
      name: "スポーツ枠",
      criteria: [
        { id: "skill", label: "技術", description: "", weight: 3 },
        { id: "attitude", label: "姿勢", description: "", weight: 1 },
      ],
      questions: [{ text: "競技歴", minutes: 3 }, { text: "目標", minutes: null }],
      passLine: 3.5,
    };
    const put = await admin.req("PUT", "/api/settings", { ...s, templates: [...s.templates, sports] });
    expect(put.status).toBe(200);
    // 面接官は設定を変えられない
    expect((await alice.req("PUT", "/api/settings", { ...s })).status).toBe(403);

    const r = await alice.req("POST", "/api/interviews", { candidate: { displayName: "スポーツの人" }, templateId: "sports" });
    expect(r.status).toBe(200);
    const iv = (r.json as InterviewDetail).interview;
    expect(iv.templateName).toBe("スポーツ枠");
    expect(iv.criteria.map((c) => c.id)).toEqual(["skill", "attitude"]);
    expect(iv.passLine).toBe(3.5);
    expect(iv.questions).toEqual(["競技歴", "目標"]);
    expect(iv.questionMinutes).toEqual([3, null]);

    // 評価は面接の評価項目で検証する(標準の項目は求められない)
    const ev = await alice.req("PUT", `/api/interviews/${iv.id}/evaluations/me`, { ratings: { skill: 5, attitude: 2 }, vote: "pass", submit: true });
    expect(ev.status).toBe(200);
    const missing = await bob.req("PUT", `/api/interviews/${iv.id}/evaluations/me`, { ratings: { skill: 4 }, vote: "pass", submit: true });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain("姿勢");

    // 評価シートの項目を変えても、登録済みの面接の項目は変わらない
    const s2 = await settings();
    const changed = s2.templates.map((t) => (t.id === "sports" ? { ...t, criteria: [{ id: "speed", label: "速さ", description: "", weight: 1 }] } : t));
    expect((await admin.req("PUT", "/api/settings", { ...s2, templates: changed })).status).toBe(200);
    const d = (await alice.req("GET", `/api/interviews/${iv.id}`)).json as InterviewDetail;
    expect(d.criteria.map((c) => c.id)).toEqual(["skill", "attitude"]);

    // 評価が入力されたあとは評価シートを変えられない
    const s3 = await settings();
    const patch = await alice.req("PATCH", `/api/interviews/${iv.id}`, { templateId: s3.defaultTemplateId });
    expect(patch.status).toBe(409);
  });

  it("一覧の合計点は重み付き平均で、非公開中は出さない", async () => {
    const s = await settings();
    const tpl = {
      id: "weighted",
      name: "重みつき",
      criteria: [
        { id: "a", label: "A", description: "", weight: 3 },
        { id: "b", label: "B", description: "", weight: 1 },
      ],
      questions: [],
      passLine: null,
    };
    expect((await admin.req("PUT", "/api/settings", { ...s, templates: [...s.templates, tpl] })).status).toBe(200);
    const r = await alice.req("POST", "/api/interviews", {
      candidate: { displayName: "重みの人" },
      templateId: "weighted",
      interviewerIds: [ids.alice, ids.bob],
    });
    const iid = r.json.interview.id as string;
    await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: { a: 5, b: 1 }, vote: "pass", submit: true });
    // (5×3 + 1×1) / 4 = 4.0
    const listA = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(listA.find((x) => x.id === iid)!.score).toBeCloseTo(4.0, 5);
    // bob は未提出なので見えない(非公開ルール)
    const listB = (await bob.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(listB.find((x) => x.id === iid)!.score).toBeNull();
    expect(weightedScore(tpl.criteria, { a: 5, b: 1 })).toBeCloseTo(4.0, 5);
  });

  it("評価シートの入力検証: 項目なし・名前の重複・重みの範囲", async () => {
    const s = await settings();
    const bad1 = await admin.req("PUT", "/api/settings", { ...s, templates: [{ ...s.templates[0], criteria: [] }] });
    expect(bad1.status).toBe(400);
    const bad2 = await admin.req("PUT", "/api/settings", { ...s, templates: [s.templates[0], { ...s.templates[0], id: "dup" }] });
    expect(bad2.status).toBe(400);
    const bad3 = await admin.req("PUT", "/api/settings", {
      ...s,
      templates: [{ ...s.templates[0], criteria: [{ id: "x", label: "X", description: "", weight: 9 }] }],
    });
    expect(bad3.status).toBe(400);
  });
});

describe("v0.2 までのデータの移行", () => {
  it("古い設定(評価項目・質問が1組)は「標準」の評価シートになり、古い面接は評価項目の写しを持つ", async () => {
    const legacy = mergeSettings({
      criteria: [{ id: "old1", label: "旧項目", description: "" }],
      defaultQuestions: ["旧質問"],
    } as never);
    expect(legacy.templates).toHaveLength(1);
    expect(legacy.templates[0].criteria).toEqual([{ id: "old1", label: "旧項目", description: "", weight: 1 }]);
    expect(legacy.templates[0].questions).toEqual([{ text: "旧質問", minutes: null }]);

    // 保存済みの古い面接を読み込む
    const dir = path.join(server.dataDir, "legacy-store");
    mkdirSync(path.join(dir, "interviews", "legacyIv01"), { recursive: true });
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ criteria: [{ id: "old1", label: "旧項目", description: "" }], defaultQuestions: ["旧質問"] }),
    );
    writeFileSync(
      path.join(dir, "interviews", "legacyIv01", "interview.json"),
      JSON.stringify({
        id: "legacyIv01",
        candidate: { displayName: "旧", kana: "", age: null, minor: false, note: "" },
        scheduledAt: null,
        location: "",
        interviewerIds: [],
        questions: ["旧質問"],
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "x",
        updatedAt: "2026-01-01T00:00:00.000Z",
        consent: null,
        recordingDeclined: false,
        recordings: [],
        decision: null,
      }),
    );
    const store = await Store.open(dir);
    const iv = store.interviews.get("legacyIv01")!;
    expect(iv.criteria.map((c) => c.id)).toEqual(["old1"]);
    expect(iv.questionMinutes).toEqual([null]);
    expect(iv.applicantId).toBe("legacyIv01");
    expect(iv.round).toBe("");
  });
});

describe("同じ候補者の面接(一次・二次)", () => {
  it("次の面接は前の面接と同じ候補者としてまとまり、詳細で互いに見える", async () => {
    const first = await newInterview(alice, { candidate: { displayName: "まとめ太郎" }, round: "一次面接", interviewerIds: [ids.alice] });
    const second = await alice.req("POST", "/api/interviews", {
      candidate: { displayName: "まとめ太郎" },
      round: "二次面接",
      fromInterviewId: first,
      interviewerIds: [ids.alice],
    });
    expect(second.status).toBe(200);
    const d2 = second.json as InterviewDetail;
    const d1 = (await alice.req("GET", `/api/interviews/${first}`)).json as InterviewDetail;
    expect(d2.interview.applicantId).toBe(d1.interview.applicantId);
    expect(d2.otherRounds.map((r) => r.id)).toEqual([first]);
    expect(d1.otherRounds.map((r) => r.round)).toEqual(["二次面接"]);
    // 存在しない面接からは作れない
    expect((await alice.req("POST", "/api/interviews", { candidate: { displayName: "x" }, fromInterviewId: "nosuchinterview" })).status).toBe(400);
  });
});

describe("閲覧範囲(担当の面接だけ)", () => {
  it("「担当の面接だけ」にすると、面接官は担当外の面接を一覧でも詳細でも見られない(管理者はすべて見られる)", async () => {
    const mine = await newInterview(alice, { candidate: { displayName: "アリスの担当" }, interviewerIds: [ids.alice] });
    const others = await newInterview(admin, { candidate: { displayName: "ボブの担当" }, interviewerIds: [ids.bob] });

    const s = await settings();
    expect((await admin.req("PUT", "/api/settings", { ...s, access: { interviewerScope: "assigned" } })).status).toBe(200);
    try {
      const list = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
      expect(list.some((x) => x.id === mine)).toBe(true);
      expect(list.some((x) => x.id === others)).toBe(false);
      // 詳細・評価・メモ・録画など、面接ごとの API はすべて 404
      expect((await alice.req("GET", `/api/interviews/${others}`)).status).toBe(404);
      expect((await alice.req("PUT", `/api/interviews/${others}/evaluations/me`, { ratings: RATINGS, vote: "pass" })).status).toBe(404);
      expect((await alice.req("POST", `/api/interviews/${others}/notes`, { text: "x" })).status).toBe(404);
      expect((await alice.req("POST", `/api/interviews/${others}/recordings`, { clientId: "dev-scope-1", source: "live", mimeType: "video/webm" })).status).toBe(404);
      // 自分の担当・管理者は見られる
      expect((await alice.req("GET", `/api/interviews/${mine}`)).status).toBe(200);
      expect((await bob.req("GET", `/api/interviews/${others}`)).status).toBe(200);
      expect((await admin.req("GET", `/api/interviews/${mine}`)).status).toBe(200);
      // 見られない面接を「前の面接」にして候補者を結びつけることもできない
      expect((await alice.req("POST", "/api/interviews", { candidate: { displayName: "x" }, fromInterviewId: others })).status).toBe(400);
    } finally {
      const s2 = await settings();
      await admin.req("PUT", "/api/settings", { ...s2, access: { interviewerScope: "all" } });
    }
    expect((await alice.req("GET", `/api/interviews/${others}`)).status).toBe(200);
  });
});

describe("ライブ視聴・面接室へのメッセージ", () => {
  it("録画している端末の心拍で録画中になり、受信済みのチャンクを取得でき、完了すると終わる", async () => {
    const { fromDevice, WEBM } = await import("./helpers/http");
    const iid = await newInterview(alice, { candidate: { displayName: "ライブの人" }, interviewerIds: [ids.alice, ids.bob] });
    const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-live-1", source: "live", mimeType: "video/webm;codecs=vp8,opus" });
    const rid = r.json.recording.id as string;
    // 心拍は録画した端末だけ
    expect((await bob.req("POST", `/api/interviews/${iid}/recordings/${rid}/live`, { elapsedMs: 1000 })).status).toBe(403);
    const hb = await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/live`, { elapsedMs: 12_000, question: "自己紹介" }, { headers: fromDevice("dev-live-1") });
    expect(hb.status).toBe(200);
    expect(hb.json.live.elapsedMs).toBeGreaterThanOrEqual(12_000);
    expect(hb.json.live.question).toBe("自己紹介");

    // 一覧・詳細で録画中と分かる
    const list = (await bob.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(list.find((x) => x.id === iid)!.live).toBe(true);
    const d = (await bob.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings[0].live?.question).toBe("自己紹介");

    // 受信済みのチャンクを取得できる(まだ届いていない番号は 404)
    await alice.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice("dev-live-1") });
    const c0 = await bob.req("GET", `/api/interviews/${iid}/recordings/${rid}/chunks/0`);
    expect(c0.status).toBe(200);
    expect(c0.buf.length).toBe(WEBM().length);
    expect((await bob.req("GET", `/api/interviews/${iid}/recordings/${rid}/chunks/5`)).status).toBe(404);

    // ライブで見ながらのメモは、サーバーが録画の経過時間を付ける
    const note = await bob.req("POST", `/api/interviews/${iid}/notes`, { recordingId: rid, live: true, text: "ライブのメモ" });
    expect(note.status).toBe(200);
    expect(note.json.note.tMs).toBeGreaterThanOrEqual(12_000);
    expect(note.json.note.tMs).toBeLessThan(20_000);

    // 完了すると録画中ではなくなり、チャンクも取れなくなる
    await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice("dev-live-1") });
    const d2 = (await bob.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d2.interview.recordings[0].live).toBeNull();
    expect((await bob.req("GET", `/api/interviews/${iid}/recordings/${rid}/chunks/0`)).status).toBe(404);
    expect((await bob.req("POST", `/api/interviews/${iid}/notes`, { recordingId: rid, live: true, text: "遅れたメモ" })).status).toBe(409);
    expect((await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/live`, { elapsedMs: 13_000 }, { headers: fromDevice("dev-live-1") })).status).toBe(409);
    await server.app.ctx.jobs.idle();
  });

  it("面接室へのメッセージは、評価を提出していない面接官にも見え、録画端末が取得できる", async () => {
    const iid = await newInterview(admin, { candidate: { displayName: "メッセージの人" }, interviewerIds: [ids.alice, ids.bob] });
    const since = new Date(Date.now() - 1000).toISOString();
    await admin.req("POST", `/api/interviews/${iid}/notes`, { text: "管理者のふつうのメモ" });
    const msg = await admin.req("POST", `/api/interviews/${iid}/notes`, { kind: "room", text: "最後に部活のことを聞いてください" });
    expect(msg.status).toBe(200);
    // alice は評価を提出していないので、ふつうのメモは見えないが、メッセージは見える
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.notes.notes.map((n) => n.text)).toEqual(["最後に部活のことを聞いてください"]);
    expect(d.notes.hiddenCount).toBe(1);
    const got = await alice.req("GET", `/api/interviews/${iid}/room-messages?since=${encodeURIComponent(since)}`);
    expect(got.json.messages.map((m: { text: string }) => m.text)).toEqual(["最後に部活のことを聞いてください"]);
    const later = await alice.req("GET", `/api/interviews/${iid}/room-messages?since=${encodeURIComponent(got.json.messages[0].createdAt)}`);
    expect(later.json.messages).toHaveLength(0);
  });
});

describe("記録票・合否通知書", () => {
  it("印刷の記録が操作ログに残る。合否通知書の印刷は管理者だけ", async () => {
    const iid = await newInterview(alice, { candidate: { displayName: "印刷の人" } });
    expect((await alice.req("POST", `/api/interviews/${iid}/printed`, { kind: "report" })).status).toBe(200);
    expect((await alice.req("POST", `/api/interviews/${iid}/printed`, { kind: "notice" })).status).toBe(403);
    expect((await admin.req("POST", `/api/interviews/${iid}/printed`, { kind: "notice" })).status).toBe(200);
    const log = (await admin.req("GET", "/api/audit")).json.entries as { action: string; interviewId: string }[];
    expect(log.some((e) => e.action === "report_print" && e.interviewId === iid)).toBe(true);
    expect(log.some((e) => e.action === "notice_print" && e.interviewId === iid)).toBe(true);
  });

  it("通知書の文面を設定で変更でき、差し込みは候補者・保護者・団体名に置き換わる", async () => {
    const { renderNotice } = await import("../src/shared/notice");
    const s = await settings();
    const notices = { ...s.notices, pass: { title: "合格のお知らせ", body: "{宛名}\n{団体名}の面接({面接日})の結果、合格です。" } };
    expect((await admin.req("PUT", "/api/settings", { ...s, notices })).status).toBe(200);
    const s2 = await settings();
    expect(s2.notices.pass.title).toBe("合格のお知らせ");
    const iv = {
      candidate: { displayName: "Y.T.", kana: "", age: 12, minor: true, note: "" },
      consent: { candidateName: "山田 太郎", guardianName: "山田 花子" },
      scheduledAt: "2026-10-01T01:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
    } as never;
    const r = renderNotice(s2.notices.pass, iv, { orgName: "テスト塾", contact: "03-0000-0000" });
    expect(r.body).toBe("山田 花子 様\n山田 太郎 様\nテスト塾の面接(2026年10月1日)の結果、合格です。");
    // 本文が短すぎるものは保存できない
    expect((await admin.req("PUT", "/api/settings", { ...s2, notices: { ...s2.notices, fail: { title: "x", body: "短い" } } })).status).toBe(400);
  });
});
