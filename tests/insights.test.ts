// 比較と傾向の結合テスト: 表情の指標の分布(年代別)、候補者の比較一覧、面接官の評価の傾向、絞り込んだ CSV。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERVIEW_ANALYSIS } from "../src/config/scoring";
import type { CompareRow, ExpressionCompare, InterviewListItem, RaterStats } from "../src/shared/types";
import { fromDevice, newInterview, RATINGS, readyRecording, setupTeam, startServer, trackGz, type Client, type TestServer } from "./helpers/http";

let server: TestServer;
let admin: Client;
let alice: Client;
let bob: Client;
let ids: Record<string, string>;
const prevTranscode = process.env.TRANSCODE;

beforeAll(async () => {
  // 再生用 MP4 の作成は不要(件数が多いので省く)
  process.env.TRANSCODE = "0";
  server = await startServer();
  ({ admin, alice, bob, ids } = await setupTeam(server));
});

afterAll(async () => {
  await server.close();
  if (prevTranscode === undefined) delete process.env.TRANSCODE;
  else process.env.TRANSCODE = prevTranscode;
});

let seq = 0;

/** 面接を作り、録画と表情の計測データを送る */
async function measured(age: number | null, extra: Record<string, unknown> = {}): Promise<string> {
  seq++;
  const iid = await newInterview(admin, { candidate: { displayName: `計測${seq}`, age }, interviewerIds: [ids.alice, ids.bob], ...extra });
  const clientId = `dev-insight-${seq}`;
  const rid = await readyRecording(server, admin, iid, clientId);
  const t = await admin.req("PUT", `/api/interviews/${iid}/recordings/${rid}/track`, undefined, {
    raw: trackGz(60, seq),
    contentType: "application/gzip",
    headers: fromDevice(clientId),
  });
  expect(t.status).toBe(200);
  return iid;
}

const compareOf = async (c: Client, iid: string) => (await c.req("GET", `/api/interviews/${iid}/expression-compare`)).json as ExpressionCompare;
const rowsOf = async (c: Client) => (await c.req("GET", "/api/compare")).json.rows as CompareRow[];

describe("表情の指標の分布(これまでの面接・同じ年代)", () => {
  let target = "";
  let second = "";

  it("件数が少ないうちは値を返さない。同じ候補者(ほかの回の面接)は比べる相手に入れない", async () => {
    target = await measured(11);
    let c = await compareOf(alice, target);
    expect(c.minN).toBe(INTERVIEW_ANALYSIS.COMPARE_MIN_N);
    expect(c.all).toEqual({ n: 0, values: {} });
    expect(c.band).toEqual({ label: "10〜12歳", n: 0, values: {} });

    second = await measured(11, { fromInterviewId: target, round: "二次面接" });
    for (let i = 0; i < 9; i++) await measured(10 + (i % 3));
    await measured(15);

    c = await compareOf(alice, target);
    // 本人の2件を除いた 10 件(同じ年代 9 件 + 別の年代 1 件)
    expect(c.all.n).toBe(10);
    expect(c.all.values.expressiveness).toHaveLength(10);
    const xs = c.all.values.expressiveness;
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(c.band!.n).toBe(9);
    expect(c.band!.values).toEqual({});
    // どの面接の値かは分からない(面接 ID を返さない)
    const text = JSON.stringify(c);
    expect(text).not.toContain(second);
    expect(text).not.toContain(target);
  });

  it("同じ年代が十分にたまると、年代の分布も返す。年齢が未入力なら年代はない", async () => {
    await measured(12);
    const c = await compareOf(bob, target);
    expect(c.all.n).toBe(11);
    expect(c.band!.n).toBe(10);
    expect(c.band!.values.smileRate.length).toBeGreaterThan(0);

    const noAge = await newInterview(admin, { candidate: { displayName: "年齢なし" } });
    expect((await compareOf(alice, noAge)).band).toBeNull();
    // 以前の、面接 ID つきで全件を返す API はない
    expect((await alice.req("GET", "/api/stats/expression")).status).toBe(404);
  });

  it("「担当の面接だけ」の設定では、担当でない面接の分布は見られない", async () => {
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    expect((await admin.req("PUT", "/api/settings", { ...s, access: { interviewerScope: "assigned" } })).status).toBe(200);
    try {
      const other = await newInterview(admin, { candidate: { displayName: "担当外", age: 11 }, interviewerIds: [ids.bob] });
      expect((await alice.req("GET", `/api/interviews/${other}/expression-compare`)).status).toBe(404);
      expect((await bob.req("GET", `/api/interviews/${other}/expression-compare`)).status).toBe(200);
      // 比較一覧にも出ない
      expect((await rowsOf(alice)).some((r) => r.id === other)).toBe(false);
      expect((await rowsOf(bob)).some((r) => r.id === other)).toBe(true);
      // 分布にも、見られない面接の値は入れない(応答の差から、見られない面接の値を割り出せないように)
      const hidden = await measured(11, { interviewerIds: [ids.bob] });
      const forAlice = await compareOf(alice, target);
      const forBob = await compareOf(bob, target);
      expect(forBob.all.n).toBe(forAlice.all.n + 1);
      expect(forBob.band!.n).toBe(forAlice.band!.n + 1);
      expect((await alice.req("GET", `/api/interviews/${hidden}/expression-compare`)).status).toBe(404);
    } finally {
      const s2 = (await admin.req("GET", "/api/settings")).json.settings;
      await admin.req("PUT", "/api/settings", { ...s2, access: { interviewerScope: "all" } });
    }
  });

  it("比較一覧に計測値(代表の録画の全体値)が出る。計測がない面接は空", async () => {
    const rows = await rowsOf(alice);
    expect(rows.find((r) => r.id === target)!.expression!.expressiveness).toBeGreaterThan(0);
    const plain = await newInterview(admin, { candidate: { displayName: "計測なし" } }, { analysis: false });
    expect((await rowsOf(alice)).find((r) => r.id === plain)!.expression).toBeNull();
  });
});

describe("候補者の比較一覧", () => {
  it("評価の非公開のルールに従い、自分が提出するまでは点数・票・項目の平均を返さない", async () => {
    const iid = await newInterview(admin, { candidate: { displayName: "比較の人", kana: "ひかく", age: 12, note: "申し送り" }, interviewerIds: [ids.alice, ids.bob] });
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: RATINGS, vote: "pass", submit: true })).status).toBe(200);

    const rb = (await rowsOf(bob)).find((r) => r.id === iid)!;
    expect(rb.visible).toBe(false);
    expect(rb.score).toBeNull();
    expect(rb.votes).toBeNull();
    expect(rb.criteria).toBeNull();
    expect(rb.submittedCount).toBe(1);
    expect(rb.expectedCount).toBe(2);
    // 面接官への申し送り(メモ)は一覧に出さない
    expect("note" in rb.candidate).toBe(false);

    const ra = (await rowsOf(alice)).find((r) => r.id === iid)!;
    expect(ra.visible).toBe(true);
    expect(ra.score).toBeCloseTo((4 + 3 + 5 + 4 + 3) / 5, 5);
    expect(ra.votes).toEqual({ pass: 1, hold: 0, fail: 0 });
    expect(ra.criteria!.find((c) => c.label === "意欲・熱意")!.avg).toBe(5);
    expect(ra.templateName).toBe("標準");

    // 管理者には見える
    expect((await rowsOf(admin)).find((r) => r.id === iid)!.visible).toBe(true);
  });

  it("面接一覧の項目に、質問の時間の目安の合計がつく(予定表の終わりの時刻に使う)", async () => {
    const iid = await newInterview(admin, { candidate: { displayName: "時間の人" } });
    const list = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(list.find((x) => x.id === iid)!.plannedMinutes).toBe(2 + 3 + 3 + 3 + 2);
  });

  it("表示中の面接だけを CSV で保存できる(管理者)", async () => {
    const rows = await rowsOf(admin);
    const pick = rows.filter((r) => r.candidate.displayName.startsWith("計測")).slice(0, 2);
    const r = await admin.req("POST", "/api/export/interviews.csv", { ids: pick.map((x) => x.id) });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(decodeURIComponent(String(r.headers["content-disposition"]))).toContain("面接比較_");
    const lines = r.buf.toString("utf8").replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(1 + pick.length);
    for (const p of pick) expect(lines.some((l) => l.startsWith(`${p.id},`))).toBe(true);

    expect((await alice.req("POST", "/api/export/interviews.csv", { ids: [pick[0].id] })).status).toBe(403);
    expect((await admin.req("POST", "/api/export/interviews.csv", { ids: ["../etc"] })).status).toBe(400);
  });
});

describe("面接官の評価の傾向", () => {
  it("同じ面接のほかの面接官の平均との差・判定との一致・提出までの時間を返す。面接官には自分の分だけ", async () => {
    const all5 = { manner: 5, response: 5, motivation: 5, cooperation: 5, expression: 5 };
    const all3 = { manner: 3, response: 3, motivation: 3, cooperation: 3, expression: 3 };
    const iid = await newInterview(admin, {
      candidate: { displayName: "傾向の人" },
      interviewerIds: [ids.alice, ids.bob],
      scheduledAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    });
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: all5, vote: "pass", submit: true })).status).toBe(200);
    expect((await bob.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: all3, vote: "fail", submit: true })).status).toBe(200);
    expect((await admin.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "" })).status).toBe(200);

    const raters = (await admin.req("GET", "/api/stats/raters")).json.raters as RaterStats[];
    const a = raters.find((r) => r.userId === ids.alice)!;
    const b = raters.find((r) => r.userId === ids.bob)!;
    // 「比較の人」は alice だけが提出したので、差の計算に入るのはこの面接だけ
    expect(a.panelCount).toBe(1);
    expect(a.meanDiff).toBeCloseTo(2, 5);
    expect(b.meanDiff).toBeCloseTo(-2, 5);
    expect(a.meanAbsDiff).toBeCloseTo(2, 5);
    expect(a.decisionAgreement).toEqual({ n: 1, agree: 1 });
    expect(b.decisionAgreement).toEqual({ n: 1, agree: 0 });
    expect(a.criteria.find((c) => c.label === "表現力")!.meanDiff).toBeCloseTo(2, 5);
    expect(b.votes.fail).toBe(1);
    expect(b.medianSubmitHours).toBeCloseTo(2, 1);

    const own = (await bob.req("GET", "/api/stats/raters")).json.raters as RaterStats[];
    expect(own.map((r) => r.userId)).toEqual([ids.bob]);
  });
});
