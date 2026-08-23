// 特徴量 → 正規化 → 2軸 → 象限 → 確信度(§6)。
// 定数はすべて config/scoring.ts 側。ここはロジックのみ。

import {
  CONFIDENCE,
  LEXICON_FEATURES,
  NORMS,
  QUADRANTS,
  WEIGHTS,
  type Axis,
  type QuadrantKey,
  type ScoredFeatureKey,
} from "../config/scoring";
import { clamp } from "./dsp";
import type { FeatureValues } from "./features";

/** 正規化(§6.1): low〜high を 0〜100 に線形マップ、範囲外クリップ、invert は反転。 */
export function normalizeValue(key: ScoredFeatureKey, raw: number): number {
  const { low, high, invert } = NORMS[key];
  const v = clamp(((raw - low) / (high - low)) * 100, 0, 100);
  return invert ? 100 - v : v;
}

export type Contribution = {
  key: ScoredFeatureKey;
  raw: number | null;
  norm: number | null;
  /** 設定上の重み */
  weight: number;
  /** 再正規化後に実際に使われた重み(除外時 0) */
  weightUsed: number;
  /** 軸スコアへの寄与(norm × weightUsed) */
  points: number | null;
  excludedReason: "missing" | "lexicon-unreliable" | null;
};

export type AxisScore = {
  score: number | null;
  contributions: Contribution[];
  usedWeightSum: number;
};

/**
 * 軸スコア(§6.2)。null の特徴量は重みゼロにして残りを再正規化する。
 * lexiconReliable=false のときは辞書由来の特徴量も除外する(付録A)。
 */
export function scoreAxis(
  axis: Axis,
  features: FeatureValues,
  opts: { lexiconReliable: boolean },
): AxisScore {
  const weights = WEIGHTS[axis];
  const entries = Object.entries(weights) as [ScoredFeatureKey, number][];

  const contributions: Contribution[] = [];
  let availableSum = 0;
  for (const [key, weight] of entries) {
    const raw = features[key];
    const lexExcluded = !opts.lexiconReliable && LEXICON_FEATURES.includes(key);
    const excludedReason =
      raw === null ? ("missing" as const) : lexExcluded ? ("lexicon-unreliable" as const) : null;
    const norm = raw === null ? null : normalizeValue(key, raw);
    contributions.push({ key, raw, norm, weight, weightUsed: 0, points: null, excludedReason });
    if (excludedReason === null) availableSum += weight;
  }

  if (availableSum <= 0) {
    return { score: null, contributions, usedWeightSum: 0 };
  }

  let score = 0;
  for (const c of contributions) {
    if (c.excludedReason !== null || c.norm === null) continue;
    c.weightUsed = c.weight / availableSum;
    c.points = c.norm * c.weightUsed;
    score += c.points;
  }
  return { score, contributions, usedWeightSum: availableSum };
}

export function quadrantOf(assertiveness: number, expressiveness: number): QuadrantKey {
  const aHigh = assertiveness >= 50;
  const eHigh = expressiveness >= 50;
  for (const [key, q] of Object.entries(QUADRANTS) as [QuadrantKey, (typeof QUADRANTS)[QuadrantKey]][]) {
    if (q.assertHigh === aHigh && q.expressHigh === eHigh) return key;
  }
  return "thinker";
}

export type ConfidenceLabel = "high" | "mid" | "low";

export type ConfidenceInput = {
  /** 顔検出率 0-1 */
  faceDetectRate: number;
  /** セッション全体の発話秒数 */
  speechSec: number;
  assertiveness: number | null;
  expressiveness: number | null;
  /** 環境チェック全項目合格か */
  gatePassed: boolean;
  /** 「チェックを無視して開始」したか(§4: 強制的に「低」) */
  gateSkipped: boolean;
  /** 言語特徴が使えたか。使えない場合は1段下げる(§6.2) */
  languageAvailable: boolean;
};

export type ConfidenceResult = {
  value: number;
  label: ConfidenceLabel;
  factors: {
    trackingQuality: number;
    speechCoverage: number;
    centerDistance: number;
    envGate: number;
  };
};

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const trackingQuality = clamp(input.faceDetectRate, 0, 1);
  const speechCoverage = clamp(input.speechSec / CONFIDENCE.SPEECH_FULL_SEC, 0, 1);
  const a = input.assertiveness;
  const e = input.expressiveness;
  const centerDistance =
    a === null || e === null
      ? 0
      : clamp(Math.min(Math.abs(a - 50), Math.abs(e - 50)) / CONFIDENCE.CENTER_FULL_PT, 0, 1);
  const envGate = input.gatePassed ? 1.0 : CONFIDENCE.GATE_FAIL_FACTOR;

  const value = Math.min(trackingQuality, speechCoverage, centerDistance, envGate);

  let label: ConfidenceLabel =
    value >= CONFIDENCE.HIGH_MIN ? "high" : value >= CONFIDENCE.MID_MIN ? "mid" : "low";

  // 言語特徴なしは1段下げる(§6.2)
  if (!input.languageAvailable) {
    label = label === "high" ? "mid" : "low";
  }
  // 環境チェックを無視して開始した場合は強制的に「低」(§4)
  if (input.gateSkipped) label = "low";

  return { value, label, factors: { trackingQuality, speechCoverage, centerDistance, envGate } };
}

export const CONFIDENCE_LABEL_JA: Record<ConfidenceLabel, string> = {
  high: "高",
  mid: "中",
  low: "低",
};

export type ScoreResult = {
  assertiveness: AxisScore;
  expressiveness: AxisScore;
  quadrant: QuadrantKey | null;
  confidence: ConfidenceResult;
};

/** 集計済み Analysis から結果一式を出す。 */
export function scoreSession(
  features: FeatureValues,
  flags: { languageAvailable: boolean; lexiconReliable: boolean; faceDetectRate: number; speechSec: number },
  gate: { passed: boolean; skipped: boolean },
): ScoreResult {
  const assertiveness = scoreAxis("assertiveness", features, flags);
  const expressiveness = scoreAxis("expressiveness", features, flags);
  const confidence = computeConfidence({
    faceDetectRate: flags.faceDetectRate,
    speechSec: flags.speechSec,
    assertiveness: assertiveness.score,
    expressiveness: expressiveness.score,
    gatePassed: gate.passed,
    gateSkipped: gate.skipped,
    languageAvailable: flags.languageAvailable,
  });
  const quadrant =
    assertiveness.score === null || expressiveness.score === null
      ? null
      : quadrantOf(assertiveness.score, expressiveness.score);
  return { assertiveness, expressiveness, quadrant, confidence };
}

/** ライブ用: 部分的な特徴量から軸値を出す(取れないものは再正規化で無視)。 */
export function liveAxes(
  features: FeatureValues,
  lexiconReliable: boolean,
): { a: number | null; e: number | null } {
  const a = scoreAxis("assertiveness", features, { lexiconReliable });
  const e = scoreAxis("expressiveness", features, { lexiconReliable });
  return { a: a.score, e: e.score };
}
