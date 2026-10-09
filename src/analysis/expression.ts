// 顔トラック → 表情の集計(運用版)。サーバーが録画ごとに実行して summary.json に保存する。
// 特徴量の定義はデモと同じ features.ts を通す(笑顔頻度・眉・うなずき等の定義を1か所に保つ)。
// 対面面接では音声に面接官の声が混ざるため、音声・言語系の特徴は使わない。

import { INTERVIEW_ANALYSIS as IA, NORMS_VERSION, SIGNAL } from "../config/scoring";
import { BLEND_COUNT, BS } from "../engine/blendshapeNames";
import { accumulateFrames, featuresFromAcc } from "../engine/features";
import type { QuestionFrames } from "../engine/ringBuffer";
import { scoreAxis } from "../engine/scoring";
import type { Marker } from "../shared/types";
import { faceHeightAt, trackToFrames, typicalStepMs, type FaceTrack } from "./faceTrack";

export type ExpressionMetrics = {
  /** 顔が映っていたフレームのうち笑顔(口角)のフレームの割合 0〜1 */
  smileRate: number | null;
  /** 1分あたりの笑顔の回数 */
  smilePerMin: number | null;
  /** 笑顔の強さ(上位10%フレームの平均) 0〜1 */
  smileIntensity: number | null;
  /** 笑顔のうち頬の上がりを伴う割合(参考) */
  duchenneRatio: number | null;
  /** 眉が上がっていたフレームの割合 */
  browActivity: number | null;
  /** 表情量の標準偏差 */
  expressionVariance: number | null;
  /** うなずき指標(回/分) */
  nodRate: number | null;
  /** まばたき(回/分、参考) */
  blinkRate: number | null;
  /** 頭部の向きの変動(度、参考) */
  poseStability: number | null;
  /** 下を向いていたフレームの割合(参考) */
  lookDownRatio: number | null;
  /** 区間のうち顔を計測できた割合 */
  faceDetectRate: number;
  /** 顔を計測できた秒数 */
  detectedSec: number;
  /** 表情の豊かさ(総合) 0〜100。暫定基準 */
  expressiveness: number | null;
};

export type SegmentSummary = {
  label: string;
  /** question: 質問マーカー区間 / preamble: 最初の質問より前 */
  kind: "question" | "preamble";
  startMs: number;
  endMs: number;
  metrics: ExpressionMetrics;
};

export type HighlightKind = "smile" | "expression" | "gap";

export type Highlight = {
  kind: HighlightKind;
  tMs: number;
  endMs: number | null;
  value: number;
  label: string;
};

export type QualityLevel = "high" | "mid" | "low";

export type QualityReport = {
  level: QualityLevel;
  /** 実効の解析レート(回/秒) */
  analysisFps: number;
  faceDetectRate: number;
  medianFaceHeight: number | null;
  multiFaceRate: number;
  analysisGapSec: number;
  detectedSec: number;
  notes: string[];
};

export type ExpressionSummary = {
  analysisVersion: string;
  normsVersion: string;
  computedAt: string;
  source: "live" | "file";
  durationMs: number;
  frameCount: number;
  /** pitch の中央値(度)。下向き判定の基準 */
  baselinePitch: number | null;
  overall: ExpressionMetrics;
  segments: SegmentSummary[];
  highlights: Highlight[];
  quality: QualityReport;
};

/** 1フレームの表情量(features.ts と同じ定義) */
function exprEnergy(blend: Float32Array | Uint8Array, base: number, scale: number): number {
  const smile = (blend[base + BS.smileL] + blend[base + BS.smileR]) / 2 / scale;
  const cheek = (blend[base + BS.cheekL] + blend[base + BS.cheekR]) / 2 / scale;
  return (
    smile * 2 +
    cheek * 2 +
    blend[base + BS.browInner] / scale +
    blend[base + BS.browOuterL] / scale +
    blend[base + BS.browOuterR] / scale
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 笑顔の回数(ヒステリシス + 最小継続時間)。顔が取れないフレームは状態を保ったまま読み飛ばす。 */
export function countSmileEpisodes(frames: QuestionFrames): number {
  const on = SIGNAL.SMILE_ON;
  const off = SIGNAL.SMILE_ON * IA.SMILE_OFF_RATIO;
  let episodes = 0;
  let inSmile = false;
  let counted = false;
  let startT = 0;
  for (let i = 0; i < frames.count; i++) {
    if (frames.detected[i] !== 1) continue;
    const base = i * BLEND_COUNT;
    const smile = (frames.blend[base + BS.smileL] + frames.blend[base + BS.smileR]) / 2;
    const t = frames.t[i];
    if (!inSmile) {
      if (smile > on) {
        inSmile = true;
        counted = false;
        startT = t;
      }
    } else if (smile < off) {
      inSmile = false;
      continue;
    }
    if (inSmile && !counted && t - startT >= IA.SMILE_EPISODE_MIN_MS) {
      episodes++;
      counted = true;
    }
  }
  return episodes;
}

function lookDownRatio(frames: QuestionFrames, baselinePitch: number | null): number | null {
  if (baselinePitch === null) return null;
  let det = 0;
  let down = 0;
  for (let i = 0; i < frames.count; i++) {
    if (frames.detected[i] !== 1) continue;
    det++;
    if (frames.pitch[i] - baselinePitch > IA.LOOK_DOWN_DEG) down++;
  }
  return det > 0 ? down / det : null;
}

/** 区間1つぶんの指標。fastMotionOk = false のときは速い動き(うなずき・まばたき)を出さない */
export function metricsForFrames(
  frames: QuestionFrames,
  baselinePitch: number | null,
  fastMotionOk = true,
): ExpressionMetrics {
  const start = frames.count > 0 ? frames.t[0] : 0;
  const acc = accumulateFrames(frames, start);
  const { features: f, flags } = featuresFromAcc(acc, false);
  const detectedSec = acc.detectedSpanMs / 1000;
  const rateOk = detectedSec >= IA.MIN_DETECTED_SEC_FOR_RATE;
  const scoreOk = detectedSec >= IA.MIN_DETECTED_SEC_FOR_SCORE;
  const expressiveness = scoreOk
    ? scoreAxis("expressiveness", f, { lexiconReliable: false }).score
    : null;
  return {
    smileRate: f.smileRate,
    smilePerMin: rateOk ? countSmileEpisodes(frames) / (detectedSec / 60) : null,
    smileIntensity: f.smileIntensity,
    duchenneRatio: f.duchenneRatio,
    browActivity: f.browActivity,
    expressionVariance: f.expressionVariance,
    nodRate: rateOk && fastMotionOk ? f.nodRate : null,
    blinkRate: rateOk && fastMotionOk ? f.blinkRate : null,
    poseStability: f.poseStability,
    lookDownRatio: lookDownRatio(frames, baselinePitch),
    faceDetectRate: flags.faceDetectRate,
    detectedSec,
    expressiveness,
  };
}

/** 質問マーカーから区間を作る。マーカーがなければ空。 */
export function segmentsFromMarkers(
  markers: Marker[],
  durationMs: number,
): { label: string; kind: "question" | "preamble"; startMs: number; endMs: number }[] {
  const qs = markers
    .filter((m) => m.kind === "question" && m.tMs >= 0 && m.tMs < durationMs)
    .slice()
    .sort((a, b) => a.tMs - b.tMs);
  const out: { label: string; kind: "question" | "preamble"; startMs: number; endMs: number }[] = [];
  if (qs.length === 0) return out;
  if (qs[0].tMs >= IA.PREAMBLE_MIN_MS) {
    out.push({ label: "質問前", kind: "preamble", startMs: 0, endMs: qs[0].tMs });
  }
  for (let i = 0; i < qs.length; i++) {
    const endMs = i + 1 < qs.length ? qs[i + 1].tMs : durationMs;
    if (endMs - qs[i].tMs < 1000) continue;
    out.push({ label: qs[i].label || `質問${i + 1}`, kind: "question", startMs: qs[i].tMs, endMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 注目シーン
// ---------------------------------------------------------------------------

type Peak = { tMs: number; value: number };

function pickSeparated(peaks: Peak[], minSepMs: number, max: number): Peak[] {
  const sorted = peaks.slice().sort((a, b) => b.value - a.value);
  const chosen: Peak[] = [];
  for (const p of sorted) {
    if (chosen.length >= max) break;
    if (chosen.every((c) => Math.abs(c.tMs - p.tMs) >= minSepMs)) chosen.push(p);
  }
  return chosen;
}

function smilePeaks(frames: QuestionFrames): Peak[] {
  // 0.5秒の移動平均(顔が取れたフレームのみ)
  const ts: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < frames.count; i++) {
    if (frames.detected[i] !== 1) continue;
    const base = i * BLEND_COUNT;
    ts.push(frames.t[i]);
    vs.push((frames.blend[base + BS.smileL] + frames.blend[base + BS.smileR]) / 2);
  }
  const smooth = new Float32Array(vs.length);
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < vs.length; i++) {
    sum += vs[i];
    while (ts[i] - ts[lo] > 500) {
      sum -= vs[lo];
      lo++;
    }
    smooth[i] = sum / (i - lo + 1);
  }
  const peaks: Peak[] = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    const v = smooth[i];
    if (v >= IA.HIGHLIGHT_SMILE_MIN && v >= smooth[i - 1] && v > smooth[i + 1]) {
      peaks.push({ tMs: ts[i], value: v });
    }
  }
  return peaks;
}

function expressionPeaks(frames: QuestionFrames): Peak[] {
  // 窓内の表情量の標準偏差を、窓の半分ずつずらしながら測る
  const win = IA.EXPRESSION_WINDOW_MS;
  const peaks: Peak[] = [];
  if (frames.count === 0) return peaks;
  const t0 = frames.t[0];
  const tEnd = frames.t[frames.count - 1];
  let i = 0;
  for (let ws = t0; ws + win <= tEnd + 1; ws += win / 2) {
    while (i < frames.count && frames.t[i] < ws) i++;
    let n = 0;
    let s = 0;
    let s2 = 0;
    for (let j = i; j < frames.count && frames.t[j] < ws + win; j++) {
      if (frames.detected[j] !== 1) continue;
      const e = exprEnergy(frames.blend, j * BLEND_COUNT, 1);
      n++;
      s += e;
      s2 += e * e;
    }
    // 窓の半分以上で顔が取れていない区間は評価しない
    if (n < 8) continue;
    const m = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
    if (sd >= IA.HIGHLIGHT_EXPRESSION_MIN) peaks.push({ tMs: ws + win / 2, value: sd });
  }
  return peaks;
}

function gapRuns(frames: QuestionFrames): { startMs: number; endMs: number }[] {
  const runs: { startMs: number; endMs: number }[] = [];
  let start = -1;
  for (let i = 0; i < frames.count; i++) {
    if (frames.detected[i] !== 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const s = frames.t[start];
      const e = frames.t[i];
      if (e - s >= IA.GAP_MIN_MS) runs.push({ startMs: s, endMs: e });
      start = -1;
    }
  }
  if (start >= 0 && frames.count > 0) {
    const s = frames.t[start];
    const e = frames.t[frames.count - 1];
    if (e - s >= IA.GAP_MIN_MS) runs.push({ startMs: s, endMs: e });
  }
  return runs;
}

export function findHighlights(frames: QuestionFrames): Highlight[] {
  const out: Highlight[] = [];
  for (const p of pickSeparated(smilePeaks(frames), IA.HIGHLIGHT_MIN_SEPARATION_MS, IA.HIGHLIGHT_MAX_PER_KIND)) {
    out.push({ kind: "smile", tMs: Math.round(p.tMs), endMs: null, value: round(p.value, 3), label: "笑顔" });
  }
  for (const p of pickSeparated(expressionPeaks(frames), IA.HIGHLIGHT_MIN_SEPARATION_MS, IA.HIGHLIGHT_MAX_PER_KIND)) {
    out.push({ kind: "expression", tMs: Math.round(p.tMs), endMs: null, value: round(p.value, 3), label: "表情がよく動いた" });
  }
  const gaps = gapRuns(frames)
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .slice(0, IA.GAP_MAX_LISTED);
  for (const g of gaps) {
    const sec = (g.endMs - g.startMs) / 1000;
    out.push({
      kind: "gap",
      tMs: Math.round(g.startMs),
      endMs: Math.round(g.endMs),
      value: round(sec, 1),
      label: `顔が映っていない(${Math.round(sec)}秒)`,
    });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

// ---------------------------------------------------------------------------
// 品質
// ---------------------------------------------------------------------------

export function assessQuality(
  track: FaceTrack,
  frames: QuestionFrames,
  overall: ExpressionMetrics,
  durationMs: number,
  analysisFps: number,
): QualityReport {
  const Q = IA.QUALITY;
  const heights: number[] = [];
  let multi = 0;
  for (let i = 0; i < track.count; i++) {
    if (track.faces[i] >= 2) multi++;
    if (track.detected[i] && i % 3 === 0) heights.push(faceHeightAt(track, i));
  }
  const medianFaceHeight = median(heights);
  const multiFaceRate = track.count > 0 ? multi / track.count : 0;
  const analysisGapSec =
    track.meta.gaps.reduce((s, g) => s + Math.max(0, g.endMs - g.startMs), 0) / 1000;

  let level: QualityLevel = "high";
  const notes: string[] = [];
  const down = (to: QualityLevel) => {
    if (to === "low" || (to === "mid" && level === "high")) level = to;
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (frames.count === 0 || overall.detectedSec <= 0) {
    return {
      level: "low",
      analysisFps: round(analysisFps, 1),
      faceDetectRate: 0,
      medianFaceHeight: null,
      multiFaceRate,
      analysisGapSec,
      detectedSec: 0,
      notes: ["顔を計測できませんでした。カメラの向きと明るさを確認してください。"],
    };
  }
  if (overall.faceDetectRate < Q.DETECT_MID) {
    down("low");
    notes.push(`顔を計測できたのは録画の ${pct(overall.faceDetectRate)} だけです。`);
  } else if (overall.faceDetectRate < Q.DETECT_HIGH) {
    down("mid");
    notes.push(`顔を計測できなかった時間が録画の ${pct(1 - overall.faceDetectRate)} あります。`);
  }
  if (medianFaceHeight !== null) {
    if (medianFaceHeight < Q.FACE_H_MID) {
      down("low");
      notes.push("顔が小さく映っています。次回はカメラを候補者に近づけてください。");
    } else if (medianFaceHeight < Q.FACE_H_HIGH) {
      down("mid");
      notes.push("顔がやや小さく映っています。細かな表情は拾いにくくなります。");
    }
  }
  if (overall.detectedSec < Q.DETECTED_SEC_MID) {
    down("low");
    notes.push("計測できた時間が短すぎます。");
  } else if (overall.detectedSec < Q.DETECTED_SEC_HIGH) {
    down("mid");
    notes.push("計測できた時間が短めです。");
  }
  if (multiFaceRate > Q.MULTI_FACE_NOTE) {
    down("mid");
    notes.push("複数の顔が映っている時間が長いため、対象の取り違えがないか映像で確認してください。");
  }
  if (durationMs > 0 && (analysisGapSec * 1000) / durationMs > Q.GAP_RATIO_MID) {
    down("mid");
    notes.push("解析が止まっていた時間があります(録画中に画面を切り替えた等)。");
  }
  if (analysisFps < IA.MIN_FPS_ANY) {
    down("low");
    notes.push(`解析できたのが毎秒${analysisFps.toFixed(1)}回と少なすぎます(端末の処理能力不足の可能性)。`);
  } else if (analysisFps < IA.MIN_FPS_FAST_MOTION) {
    down("mid");
    notes.push(`解析が毎秒${analysisFps.toFixed(1)}回と少ないため、うなずき・まばたきは表示していません。`);
  }

  return {
    level,
    analysisFps: round(analysisFps, 1),
    faceDetectRate: round(overall.faceDetectRate, 4),
    medianFaceHeight: medianFaceHeight === null ? null : round(medianFaceHeight, 4),
    multiFaceRate: round(multiFaceRate, 4),
    analysisGapSec: round(analysisGapSec, 1),
    detectedSec: round(overall.detectedSec, 1),
    notes,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function roundMetrics(m: ExpressionMetrics): ExpressionMetrics {
  const r = (v: number | null, d = 4) => (v === null || !Number.isFinite(v) ? null : round(v, d));
  return {
    smileRate: r(m.smileRate),
    smilePerMin: r(m.smilePerMin, 2),
    smileIntensity: r(m.smileIntensity),
    duchenneRatio: r(m.duchenneRatio),
    browActivity: r(m.browActivity),
    expressionVariance: r(m.expressionVariance),
    nodRate: r(m.nodRate, 2),
    blinkRate: r(m.blinkRate, 2),
    poseStability: r(m.poseStability, 2),
    lookDownRatio: r(m.lookDownRatio),
    faceDetectRate: round(m.faceDetectRate, 4),
    detectedSec: round(m.detectedSec, 1),
    expressiveness: r(m.expressiveness, 1),
  };
}

export function trackDurationMs(track: FaceTrack): number {
  return track.count > 0 ? track.t[track.count - 1] + track.meta.intervalMs : 0;
}

/**
 * 録画1本の集計。durationMs は録画の長さ(不明なら顔トラックの末尾)。
 * 同じ入力からは常に同じ出力になる(computedAt を除く)。
 */
export function computeExpressionSummary(
  track: FaceTrack,
  markers: Marker[],
  durationMsIn: number | null,
): ExpressionSummary {
  const durationMs = Math.max(durationMsIn ?? 0, trackDurationMs(track));

  const pitches: number[] = [];
  for (let i = 0; i < track.count; i++) {
    if (track.detected[i]) pitches.push(track.pitch[i] / 100);
  }
  const baselinePitch = median(pitches);

  const step = typicalStepMs(track);
  const analysisFps = track.count > 1 ? 1000 / step : 0;
  const fastOk = analysisFps >= IA.MIN_FPS_FAST_MOTION;
  const all = trackToFrames(track, 0, durationMs, step);
  const overall = metricsForFrames(all, baselinePitch, fastOk);

  const segments: SegmentSummary[] = segmentsFromMarkers(markers, durationMs).map((s) => ({
    ...s,
    metrics: roundMetrics(metricsForFrames(trackToFrames(track, s.startMs, s.endMs, step), baselinePitch, fastOk)),
  }));

  return {
    analysisVersion: IA.VERSION,
    normsVersion: NORMS_VERSION,
    computedAt: new Date().toISOString(),
    source: track.meta.source,
    durationMs: Math.round(durationMs),
    frameCount: track.count,
    baselinePitch: baselinePitch === null ? null : round(baselinePitch, 2),
    overall: roundMetrics(overall),
    segments,
    highlights: findHighlights(all),
    quality: assessQuality(track, all, overall, durationMs, analysisFps),
  };
}

/** 面接全体の代表値: 顔が最も長く映っていた録画の集計を使う */
export function pickRepresentative<T extends { overall: ExpressionMetrics }>(summaries: T[]): T | null {
  let best: T | null = null;
  for (const s of summaries) {
    if (!best || s.overall.detectedSec > best.overall.detectedSec) best = s;
  }
  return best;
}
