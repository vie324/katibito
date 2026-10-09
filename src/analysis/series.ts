// 顔トラック → タイムライン描画用の等間隔系列。レビュー画面で動画と同期して描く。
// 値のないビンは NaN(描画側で途切れとして扱う)。

import { BLEND_COUNT, BS, blendIndex } from "../engine/blendshapeNames";
import { lowerBound, type FaceTrack } from "./faceTrack";

export type TimelineSeries = {
  binMs: number;
  count: number;
  /** 口角(笑顔)のビン内最大 0〜1 */
  smile: Float32Array;
  /** 眉(内側・外側の最大)のビン内最大 0〜1 */
  brow: Float32Array;
  /** 表情量のビン内平均 */
  expr: Float32Array;
  /** 頭の縦の向き(度、録画全体の中央値からの差。正 = うなずき方向) */
  pitch: Float32Array;
  /** 顔を計測できたフレームの割合 0〜1 */
  detected: Float32Array;
  /** 音量 RMS のビン内平均(音声を記録していない場合は NaN) */
  rms: Float32Array;
  /** 口の開き(jawOpen)のビン内平均 */
  mouth: Float32Array;
};

const JAW_OPEN = blendIndex("jawOpen");

export function buildTimelineSeries(track: FaceTrack, durationMs: number, binMs = 250): TimelineSeries {
  const count = Math.max(1, Math.ceil(Math.max(durationMs, 1) / binMs));
  const mk = () => new Float32Array(count).fill(NaN);
  const s: TimelineSeries = {
    binMs,
    count,
    smile: mk(),
    brow: mk(),
    expr: mk(),
    pitch: mk(),
    detected: mk(),
    rms: mk(),
    mouth: mk(),
  };

  // 下向き判定と同じ基準(中央値)
  const pitches: number[] = [];
  for (let i = 0; i < track.count; i += 2) {
    if (track.detected[i]) pitches.push(track.pitch[i]);
  }
  pitches.sort((a, b) => a - b);
  const baseline = pitches.length > 0 ? pitches[pitches.length >> 1] / 100 : 0;

  const hasAudio = track.meta.hasAudio;
  for (let b = 0; b < count; b++) {
    const i0 = lowerBound(track.t, track.count, b * binMs);
    const i1 = lowerBound(track.t, track.count, (b + 1) * binMs);
    if (i1 <= i0) continue;
    let det = 0;
    let smileMax = 0;
    let browMax = 0;
    let exprSum = 0;
    let pitchSum = 0;
    let mouthSum = 0;
    let rmsSum = 0;
    for (let i = i0; i < i1; i++) {
      rmsSum += track.rms[i];
      if (!track.detected[i]) continue;
      det++;
      const base = i * BLEND_COUNT;
      const bl = track.blend;
      const smile = (bl[base + BS.smileL] + bl[base + BS.smileR]) / 2 / 255;
      const cheek = (bl[base + BS.cheekL] + bl[base + BS.cheekR]) / 2 / 255;
      const bi = bl[base + BS.browInner] / 255;
      const bo1 = bl[base + BS.browOuterL] / 255;
      const bo2 = bl[base + BS.browOuterR] / 255;
      if (smile > smileMax) smileMax = smile;
      const brow = Math.max(bi, bo1, bo2);
      if (brow > browMax) browMax = brow;
      exprSum += smile * 2 + cheek * 2 + bi + bo1 + bo2;
      pitchSum += track.pitch[i] / 100 - baseline;
      mouthSum += bl[base + JAW_OPEN] / 255;
    }
    const n = i1 - i0;
    s.detected[b] = det / n;
    if (hasAudio) s.rms[b] = rmsSum / n / 65535;
    if (det > 0) {
      s.smile[b] = smileMax;
      s.brow[b] = browMax;
      s.expr[b] = exprSum / det;
      s.pitch[b] = pitchSum / det;
      s.mouth[b] = mouthSum / det;
    }
  }
  return s;
}

/** 描画幅に合わせてビンをまとめる(ピークを潰さないよう最大値を取る系列と平均を取る系列を分ける)。 */
export function reduceSeries(
  values: Float32Array,
  from: number,
  to: number,
  buckets: number,
  mode: "max" | "mean" | "min",
): Float32Array {
  const out = new Float32Array(buckets).fill(NaN);
  const span = Math.max(1, to - from);
  for (let k = 0; k < buckets; k++) {
    const a = from + Math.floor((k * span) / buckets);
    const b = Math.max(a + 1, from + Math.floor(((k + 1) * span) / buckets));
    let acc = mode === "max" ? -Infinity : mode === "min" ? Infinity : 0;
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(values.length, b); i++) {
      const v = values[i];
      if (Number.isNaN(v)) continue;
      n++;
      if (mode === "max") acc = v > acc ? v : acc;
      else if (mode === "min") acc = v < acc ? v : acc;
      else acc += v;
    }
    if (n > 0) out[k] = mode === "mean" ? acc / n : acc;
  }
  return out;
}
