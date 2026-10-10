// 比較と傾向の API: 候補者の比較一覧、面接官ごとの評価の傾向、表情の指標の分布(年代別)。

import { COMPARABLE_METRICS } from "../../src/analysis/metricsMeta";
import type { ExpressionMetrics } from "../../src/analysis/expression";
import { INTERVIEW_ANALYSIS } from "../../src/config/scoring";
import { ageBand } from "../../src/shared/ageBand";
import { averageScore, criterionAverages, weightedScore } from "../../src/shared/score";
import { deriveStatus, submittedEvaluations, tallyVotes } from "../../src/shared/status";
import type { CompareRow, ExpressionCompare, Interview, MetricDistribution, RaterStats, Vote } from "../../src/shared/types";
import type { AppContext } from "../context";
import type { Router } from "../http";
import { representativeSummary } from "../recordings";
import type { UserRecord } from "../store";
import { canView, evaluationVisibility, getInterview } from "./interviews";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 面接が行われた時刻: 最初の(その場で撮った)録画の開始。なければ予定日時 */
function heldAt(iv: Interview): string | null {
  const starts = iv.recordings
    .filter((r) => r.source === "live")
    .map((r) => r.startedAt)
    .sort();
  return starts[0] ?? iv.scheduledAt;
}

async function expressionOf(app: AppContext, iv: Interview): Promise<ExpressionMetrics | null> {
  if (!iv.consent?.analysis) return null;
  const s = await representativeSummary(app, iv.id);
  // 信頼度「低」の計測は比べない
  if (!s || s.quality.level === "low") return null;
  return s.overall;
}

export async function compareRow(app: AppContext, iv: Interview, user: UserRecord): Promise<CompareRow> {
  const evals = app.store.evaluationsOf(iv.id);
  const mine = evals.find((e) => e.userId === user.id) ?? null;
  const vis = evaluationVisibility(app, iv, user, mine);
  const submitted = submittedEvaluations(evals);
  const avgs = criterionAverages(iv.criteria, evals);
  const overall = await expressionOf(app, iv);
  let expression: Record<string, number | null> | null = null;
  if (overall) {
    expression = {};
    for (const k of COMPARABLE_METRICS) expression[k] = overall[k];
  }
  return {
    id: iv.id,
    candidate: {
      displayName: iv.candidate.displayName,
      kana: iv.candidate.kana,
      age: iv.candidate.age,
      minor: iv.candidate.minor,
    },
    applicantId: iv.applicantId,
    round: iv.round,
    scheduledAt: iv.scheduledAt,
    createdAt: iv.createdAt,
    templateId: iv.templateId,
    templateName: iv.templateName,
    interviewerIds: iv.interviewerIds,
    status: deriveStatus(iv, evals),
    decision: iv.decision?.result ?? null,
    submittedCount: submitted.filter((e) => iv.interviewerIds.includes(e.userId)).length,
    expectedCount: iv.interviewerIds.length,
    visible: vis.visible,
    // 非公開中は票の内訳も点数も見せない
    votes: vis.visible ? tallyVotes(evals) : null,
    score: vis.visible ? averageScore(iv.criteria, evals) : null,
    passLine: iv.passLine,
    criteria: vis.visible ? iv.criteria.map((c) => ({ label: c.label, weight: c.weight, avg: avgs[c.id] ?? null })) : null,
    expression,
  };
}

/** 面接官ごとの評価の傾向。同じ面接を評価したほかの面接官の平均との差で見る */
export function raterStats(app: AppContext): RaterStats[] {
  type Acc = {
    submitted: number;
    scores: number[];
    diffs: number[];
    votes: Record<Vote, number>;
    decN: number;
    decAgree: number;
    crit: Map<string, number[]>;
    delays: number[];
  };
  const acc = new Map<string, Acc>();
  const get = (uid: string): Acc => {
    let a = acc.get(uid);
    if (!a) {
      a = { submitted: 0, scores: [], diffs: [], votes: { pass: 0, hold: 0, fail: 0 }, decN: 0, decAgree: 0, crit: new Map(), delays: [] };
      acc.set(uid, a);
    }
    return a;
  };
  for (const iv of app.store.interviews.values()) {
    const subs = submittedEvaluations(app.store.evaluationsOf(iv.id));
    if (subs.length === 0) continue;
    const scored = subs.map((e) => ({ e, s: weightedScore(iv.criteria, e.ratings) }));
    const at = heldAt(iv);
    for (const { e, s } of scored) {
      const a = get(e.userId);
      a.submitted++;
      if (s !== null) a.scores.push(s);
      if (e.vote) {
        a.votes[e.vote]++;
        if (iv.decision) {
          a.decN++;
          if (iv.decision.result === e.vote) a.decAgree++;
        }
      }
      if (at && e.submittedAt) {
        const h = (Date.parse(e.submittedAt) - Date.parse(at)) / 3_600_000;
        if (Number.isFinite(h) && h >= 0) a.delays.push(h);
      }
      const others = scored.filter((x) => x.e.userId !== e.userId && x.s !== null).map((x) => x.s as number);
      if (s !== null && others.length > 0) a.diffs.push(s - mean(others));
      for (const cr of iv.criteria) {
        const r = e.ratings[cr.id];
        if (typeof r !== "number") continue;
        const o = subs
          .filter((x) => x.userId !== e.userId)
          .map((x) => x.ratings[cr.id])
          .filter((x): x is number => typeof x === "number");
        if (o.length === 0) continue;
        const list = a.crit.get(cr.label) ?? [];
        list.push(r - mean(o));
        a.crit.set(cr.label, list);
      }
    }
  }
  return [...acc.entries()]
    .map(([uid, a]) => ({
      userId: uid,
      name: app.store.userName(uid),
      submitted: a.submitted,
      meanScore: a.scores.length > 0 ? mean(a.scores) : null,
      panelCount: a.diffs.length,
      meanDiff: a.diffs.length > 0 ? mean(a.diffs) : null,
      meanAbsDiff: a.diffs.length > 0 ? mean(a.diffs.map(Math.abs)) : null,
      votes: a.votes,
      decisionAgreement: { n: a.decN, agree: a.decAgree },
      criteria: [...a.crit.entries()].map(([label, xs]) => ({ label, n: xs.length, meanDiff: mean(xs) })),
      medianSubmitHours: median(a.delays),
    }))
    .sort((x, y) => x.name.localeCompare(y.name, "ja"));
}

function distribution(list: ExpressionMetrics[], minN: number): MetricDistribution {
  const values: Record<string, number[]> = {};
  // 件数が少ないうちは値を返さない(少ない件数では、ほかの面接の値を推測できてしまう)
  if (list.length >= minN) {
    for (const k of COMPARABLE_METRICS) {
      values[k] = list
        .map((m) => m[k])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
    }
  }
  return { n: list.length, values };
}

export function registerInsightRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  r.get("/api/compare", "user", async (c) => {
    const rows: CompareRow[] = [];
    for (const iv of store.interviews.values()) {
      if (!canView(app, c.user!, iv)) continue;
      rows.push(await compareRow(app, iv, c.user!));
    }
    rows.sort((a, b) => (b.scheduledAt ?? b.createdAt).localeCompare(a.scheduledAt ?? a.createdAt));
    return { rows };
  });

  // 管理者はすべての面接官、面接官は自分の分だけ
  r.get("/api/stats/raters", "user", (c) => {
    const all = raterStats(app);
    return { raters: c.user!.role === "admin" ? all : all.filter((x) => x.userId === c.user!.id) };
  });

  // この面接の表情の指標を、これまでの面接(同じ年代)の中で位置づけるための分布
  r.get("/api/interviews/:id/expression-compare", "user", async (c): Promise<ExpressionCompare> => {
    const iv = getInterview(app, c.params.id);
    const band = ageBand(iv.candidate.age);
    const minN = INTERVIEW_ANALYSIS.COMPARE_MIN_N;
    const all: ExpressionMetrics[] = [];
    const inBand: ExpressionMetrics[] = [];
    for (const x of store.interviews.values()) {
      // 同じ候補者(ほかの回の面接を含む)とは比べない
      if (x.applicantId === iv.applicantId) continue;
      // 見られる面接だけで比べる(「担当の面接だけ」のとき、面接ごとの応答の差から見られない面接の値を割り出せないように)
      if (!canView(app, c.user!, x)) continue;
      const m = await expressionOf(app, x);
      if (!m) continue;
      all.push(m);
      if (band && ageBand(x.candidate.age)?.id === band.id) inBand.push(m);
    }
    return {
      minN,
      all: distribution(all, minN),
      band: band ? { label: band.label, ...distribution(inBand, minN) } : null,
    };
  });
}
