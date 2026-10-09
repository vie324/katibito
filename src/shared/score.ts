// 評価の合計点(重み付き平均)。一覧・集計・比較・CSV で同じ計算を使う。

import type { Criterion, Evaluation } from "./types";

/** 1人の評価の重み付き平均点(1〜5)。入力済みの項目だけで計算し、1つもなければ null */
export function weightedScore(criteria: Criterion[], ratings: Record<string, number | null>): number | null {
  let sum = 0;
  let wsum = 0;
  for (const c of criteria) {
    const r = ratings[c.id];
    if (typeof r !== "number") continue;
    const w = c.weight > 0 ? c.weight : 1;
    sum += r * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}

/** 提出済みの評価の合計点の平均 */
export function averageScore(criteria: Criterion[], evaluations: Evaluation[]): number | null {
  const xs = evaluations
    .filter((e) => e.status === "submitted")
    .map((e) => weightedScore(criteria, e.ratings))
    .filter((x): x is number => x !== null);
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** 項目ごとの平均(提出済みのみ) */
export function criterionAverages(criteria: Criterion[], evaluations: Evaluation[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const submitted = evaluations.filter((e) => e.status === "submitted");
  for (const c of criteria) {
    const xs = submitted.map((e) => e.ratings[c.id]).filter((x): x is number => typeof x === "number");
    out[c.id] = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  }
  return out;
}

/** 表示用: 3.75 → "3.8" */
export function formatScore(x: number | null | undefined): string {
  return typeof x === "number" ? x.toFixed(1) : "—";
}
