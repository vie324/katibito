// 顔トラック: 録画1本ぶんの「候補者の顔」の時系列(運用版の解析データの正本)。
// - ブラウザで録画中(live)または動画ファイルから(file)作る
// - サーバーへはバイナリ(gzip)で送り、サーバー側で集計(expression.ts)する
// - 生の blendshape を残すので、基準値(NORMS)を差し替えても再集計できる
// DOM にも Node にも依存しない純粋モジュール。

import { BLEND_COUNT, CANONICAL_BLENDSHAPES } from "../engine/blendshapeNames";
import type { QuestionFrames } from "../engine/ringBuffer";

export const TRACK_MAGIC = 0x5446544b; // "KTFT"
export const TRACK_FORMAT_VERSION = 1;
/** 3時間 × 30fps を上限とする(不正データでメモリを食わないため) */
export const TRACK_MAX_FRAMES = 3 * 3600 * 30;

export type TrackGap = {
  startMs: number;
  endMs: number;
  /** hidden: タブが非表示で解析が止まっていた / stalled: 映像が止まっていた */
  reason: "hidden" | "stalled";
};

export type FaceTrackMeta = {
  source: "live" | "file";
  /** 目標の解析間隔(ms) */
  intervalMs: number;
  videoWidth: number;
  videoHeight: number;
  blendNames: string[];
  createdAt: string;
  appVersion: string;
  gaps: TrackGap[];
  /** 音量(rms/voiced)を記録しているか */
  hasAudio: boolean;
  /** 解析対象として選んだ顔の初期位置(正規化座標) */
  target: { cx: number; cy: number } | null;
};

export type FaceTrack = {
  meta: FaceTrackMeta;
  count: number;
  /** 録画開始からの ms */
  t: Uint32Array;
  /** 候補者の顔が取れたフレーム = 1 */
  detected: Uint8Array;
  /** フレーム内に検出された顔の数 */
  faces: Uint8Array;
  /** count × BLEND_COUNT、正準順、score × 255 */
  blend: Uint8Array;
  /** 頭部姿勢(度 × 100) */
  yaw: Int16Array;
  pitch: Int16Array;
  roll: Int16Array;
  /** count × 4(x0, y0, x1, y1)、正規化座標 × 65535 */
  box: Uint16Array;
  /** 音量 RMS × 65535(音声なしは 0) */
  rms: Uint16Array;
  /** 発話区間 = 1 */
  voiced: Uint8Array;
};

export type FaceSample = {
  blend: ArrayLike<number>;
  yaw: number;
  pitch: number;
  roll: number;
  box: { x0: number; y0: number; x1: number; y1: number };
};

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const q8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const q16 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));
const qDeg = (v: number) => {
  const x = Math.round(v * 100);
  return x < -32768 ? -32768 : x > 32767 ? 32767 : x;
};

export function defaultTrackMeta(partial: Partial<FaceTrackMeta> & Pick<FaceTrackMeta, "source">): FaceTrackMeta {
  return {
    intervalMs: 66,
    videoWidth: 0,
    videoHeight: 0,
    blendNames: [...CANONICAL_BLENDSHAPES],
    createdAt: new Date().toISOString(),
    appVersion: "",
    gaps: [],
    hasAudio: false,
    target: null,
    ...partial,
  };
}

/** 録画中にフレームを積むビルダー。容量は倍々で伸ばす(ホットパスで小さな確保をしない)。 */
export class FaceTrackBuilder {
  readonly meta: FaceTrackMeta;
  private cap: number;
  private n = 0;
  private t: Uint32Array;
  private detected: Uint8Array;
  private faces: Uint8Array;
  private blend: Uint8Array;
  private yaw: Int16Array;
  private pitch: Int16Array;
  private roll: Int16Array;
  private box: Uint16Array;
  private rms: Uint16Array;
  private voiced: Uint8Array;

  constructor(meta: FaceTrackMeta, initialCapacity = 4096) {
    this.meta = meta;
    this.cap = Math.max(16, initialCapacity);
    this.t = new Uint32Array(this.cap);
    this.detected = new Uint8Array(this.cap);
    this.faces = new Uint8Array(this.cap);
    this.blend = new Uint8Array(this.cap * BLEND_COUNT);
    this.yaw = new Int16Array(this.cap);
    this.pitch = new Int16Array(this.cap);
    this.roll = new Int16Array(this.cap);
    this.box = new Uint16Array(this.cap * 4);
    this.rms = new Uint16Array(this.cap);
    this.voiced = new Uint8Array(this.cap);
  }

  get length(): number {
    return this.n;
  }

  get lastT(): number {
    return this.n > 0 ? this.t[this.n - 1] : -1;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const grow8 = (a: Uint8Array, k = 1) => {
      const b = new Uint8Array(cap * k);
      b.set(a);
      return b;
    };
    const grow16 = (a: Uint16Array, k = 1) => {
      const b = new Uint16Array(cap * k);
      b.set(a);
      return b;
    };
    const growI16 = (a: Int16Array) => {
      const b = new Int16Array(cap);
      b.set(a);
      return b;
    };
    const t = new Uint32Array(cap);
    t.set(this.t);
    this.t = t;
    this.detected = grow8(this.detected);
    this.faces = grow8(this.faces);
    this.blend = grow8(this.blend, BLEND_COUNT);
    this.yaw = growI16(this.yaw);
    this.pitch = growI16(this.pitch);
    this.roll = growI16(this.roll);
    this.box = grow16(this.box, 4);
    this.rms = grow16(this.rms);
    this.voiced = grow8(this.voiced);
    this.cap = cap;
  }

  /**
   * 1フレーム追加する。tMs は単調非減少であること(巻き戻りは無視する)。
   * face = null は「候補者の顔が取れなかった」フレーム。
   */
  push(tMs: number, faceCount: number, face: FaceSample | null, rms: number | null = null, voiced = false): boolean {
    const t = Math.max(0, Math.round(tMs));
    if (this.n > 0 && t < this.t[this.n - 1]) return false;
    if (this.n >= TRACK_MAX_FRAMES) return false;
    if (this.n >= this.cap) this.grow();
    const i = this.n;
    this.t[i] = t;
    this.faces[i] = Math.min(255, Math.max(0, faceCount | 0));
    this.rms[i] = rms === null ? 0 : q16(rms);
    this.voiced[i] = voiced ? 1 : 0;
    if (face) {
      this.detected[i] = 1;
      const base = i * BLEND_COUNT;
      for (let k = 0; k < BLEND_COUNT; k++) this.blend[base + k] = q8(face.blend[k] ?? 0);
      this.yaw[i] = qDeg(face.yaw);
      this.pitch[i] = qDeg(face.pitch);
      this.roll[i] = qDeg(face.roll);
      const b = i * 4;
      this.box[b] = q16(face.box.x0);
      this.box[b + 1] = q16(face.box.y0);
      this.box[b + 2] = q16(face.box.x1);
      this.box[b + 3] = q16(face.box.y1);
    } else {
      this.detected[i] = 0;
      this.blend.fill(0, i * BLEND_COUNT, (i + 1) * BLEND_COUNT);
      this.yaw[i] = 0;
      this.pitch[i] = 0;
      this.roll[i] = 0;
      this.box.fill(0, i * 4, i * 4 + 4);
    }
    this.n++;
    return true;
  }

  addGap(gap: TrackGap): void {
    if (gap.endMs > gap.startMs) this.meta.gaps.push({ ...gap });
  }

  /** 現時点までの内容を切り出す(コピー)。録画中の定期保存にも使う。 */
  build(): FaceTrack {
    const n = this.n;
    return {
      meta: { ...this.meta, gaps: this.meta.gaps.map((g) => ({ ...g })) },
      count: n,
      t: this.t.slice(0, n),
      detected: this.detected.slice(0, n),
      faces: this.faces.slice(0, n),
      blend: this.blend.slice(0, n * BLEND_COUNT),
      yaw: this.yaw.slice(0, n),
      pitch: this.pitch.slice(0, n),
      roll: this.roll.slice(0, n),
      box: this.box.slice(0, n * 4),
      rms: this.rms.slice(0, n),
      voiced: this.voiced.slice(0, n),
    };
  }
}

// ---------------------------------------------------------------------------
// バイナリ形式(リトルエンディアン)
//   u32 magic | u16 version | u16 blendCount | u32 count | u32 metaLen | meta(JSON, UTF-8)
//   | 4byte 境界まで 0 埋め | t(u32) yaw pitch roll(i16) box(u16×4) rms(u16) detected faces voiced(u8) blend(u8×52)
// ---------------------------------------------------------------------------

const HEADER_BYTES = 16;

function arraysByteLength(count: number, blendCount: number): number {
  return count * 4 + count * 2 * 3 + count * 2 * 4 + count * 2 + count * 3 + count * blendCount;
}

export function encodeFaceTrack(track: FaceTrack): Uint8Array {
  if (!LITTLE_ENDIAN) throw new Error("big-endian 環境は未対応です");
  const metaBytes = new TextEncoder().encode(JSON.stringify(track.meta));
  const metaPadded = Math.ceil((HEADER_BYTES + metaBytes.length) / 4) * 4;
  const n = track.count;
  const total = metaPadded + arraysByteLength(n, BLEND_COUNT);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, TRACK_MAGIC, true);
  dv.setUint16(4, TRACK_FORMAT_VERSION, true);
  dv.setUint16(6, BLEND_COUNT, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, metaBytes.length, true);
  out.set(metaBytes, HEADER_BYTES);

  let off = metaPadded;
  const put = (arr: ArrayBufferView, bytes: number) => {
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, bytes), off);
    off += bytes;
  };
  put(track.t, n * 4);
  put(track.yaw, n * 2);
  put(track.pitch, n * 2);
  put(track.roll, n * 2);
  put(track.box, n * 8);
  put(track.rms, n * 2);
  put(track.detected, n);
  put(track.faces, n);
  put(track.voiced, n);
  put(track.blend, n * BLEND_COUNT);
  return out;
}

export class TrackFormatError extends Error {}

export function decodeFaceTrack(bytes: Uint8Array): FaceTrack {
  if (!LITTLE_ENDIAN) throw new TrackFormatError("big-endian 環境は未対応です");
  if (bytes.length < HEADER_BYTES) throw new TrackFormatError("データが短すぎます");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== TRACK_MAGIC) throw new TrackFormatError("顔トラックの形式ではありません");
  const version = dv.getUint16(4, true);
  if (version !== TRACK_FORMAT_VERSION) throw new TrackFormatError(`未対応の形式バージョンです (${version})`);
  const blendCount = dv.getUint16(6, true);
  if (blendCount !== BLEND_COUNT) throw new TrackFormatError(`blendshape 数が一致しません (${blendCount})`);
  const n = dv.getUint32(8, true);
  if (n > TRACK_MAX_FRAMES) throw new TrackFormatError("フレーム数が上限を超えています");
  const metaLen = dv.getUint32(12, true);
  if (HEADER_BYTES + metaLen > bytes.length) throw new TrackFormatError("メタデータが壊れています");
  const metaPadded = Math.ceil((HEADER_BYTES + metaLen) / 4) * 4;
  if (metaPadded + arraysByteLength(n, blendCount) !== bytes.length) {
    throw new TrackFormatError("データ長が一致しません");
  }

  let meta: FaceTrackMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metaLen)));
  } catch {
    throw new TrackFormatError("メタデータを読めません");
  }
  meta = sanitizeMeta(meta);

  let off = metaPadded;
  // 整列を気にしなくてよいよう、毎回コピーしてから型付き配列にする
  const take = (bytesLen: number): ArrayBuffer => {
    const copy = bytes.slice(off, off + bytesLen);
    off += bytesLen;
    return copy.buffer;
  };
  const t = new Uint32Array(take(n * 4));
  const yaw = new Int16Array(take(n * 2));
  const pitch = new Int16Array(take(n * 2));
  const roll = new Int16Array(take(n * 2));
  const box = new Uint16Array(take(n * 8));
  const rms = new Uint16Array(take(n * 2));
  const detected = new Uint8Array(take(n));
  const faces = new Uint8Array(take(n));
  const voiced = new Uint8Array(take(n));
  const blend = new Uint8Array(take(n * blendCount));

  for (let i = 1; i < n; i++) {
    if (t[i] < t[i - 1]) throw new TrackFormatError("時刻が単調増加していません");
  }
  return { meta, count: n, t, detected, faces, blend, yaw, pitch, roll, box, rms, voiced };
}

function sanitizeMeta(raw: unknown): FaceTrackMeta {
  const m = (raw ?? {}) as Partial<FaceTrackMeta>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const gaps = Array.isArray(m.gaps)
    ? m.gaps
        .filter((g) => g && typeof g.startMs === "number" && typeof g.endMs === "number")
        .slice(0, 10_000)
        .map((g) => ({
          startMs: Math.max(0, g.startMs),
          endMs: Math.max(0, g.endMs),
          reason: g.reason === "stalled" ? ("stalled" as const) : ("hidden" as const),
        }))
    : [];
  const target =
    m.target && typeof m.target.cx === "number" && typeof m.target.cy === "number"
      ? { cx: m.target.cx, cy: m.target.cy }
      : null;
  return {
    source: m.source === "file" ? "file" : "live",
    intervalMs: Math.min(1000, Math.max(10, num(m.intervalMs, 66))),
    videoWidth: num(m.videoWidth, 0),
    videoHeight: num(m.videoHeight, 0),
    blendNames: Array.isArray(m.blendNames) ? m.blendNames.map(String).slice(0, 64) : [...CANONICAL_BLENDSHAPES],
    createdAt: typeof m.createdAt === "string" ? m.createdAt.slice(0, 40) : "",
    appVersion: typeof m.appVersion === "string" ? m.appVersion.slice(0, 40) : "",
    gaps,
    hasAudio: m.hasAudio === true,
    target,
  };
}

// ---------------------------------------------------------------------------
// 集計用の変換
// ---------------------------------------------------------------------------

/** 指定時刻以上の最初のフレーム位置(二分探索) */
export function lowerBound(t: Uint32Array, count: number, ms: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 実際のフレーム間隔(中央値)。目標の解析間隔より遅い端末では、こちらが実効の間隔になる。
 * 1秒を上限とする(それ以上空いているのは解析が止まっていた区間)。
 */
export function typicalStepMs(track: FaceTrack): number {
  const nominal = Math.max(10, track.meta.intervalMs);
  if (track.count < 3) return nominal;
  const stride = Math.max(1, Math.floor(track.count / 4000));
  const dts: number[] = [];
  for (let i = stride; i < track.count; i += stride) {
    const dt = (track.t[i] - track.t[i - stride]) / stride;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return nominal;
  dts.sort((a, b) => a - b);
  return Math.max(nominal, Math.min(1000, dts[dts.length >> 1]));
}

/**
 * [startMs, endMs) のフレームを features.ts が読める形(QuestionFrames)に変換する。
 * - 解析が止まっていた区間(タブ非表示等)は「顔なし」フレームで埋める。
 *   埋めないと平均フレーム間隔が伸び、1分あたりの指標が過小になる。
 *   「止まっていた」の判定は実際のフレーム間隔(stepMs)の3倍かつ1秒以上空いたとき
 * - 音声特徴は対面面接では面接官の声が混ざるため使わない(voiced = 0)
 */
export function trackToFrames(
  track: FaceTrack,
  startMs: number,
  endMs: number,
  stepMs: number = typicalStepMs(track),
): QuestionFrames {
  const step = Math.max(10, stepMs);
  const fillOver = Math.max(step * 3, 1000);
  const i0 = lowerBound(track.t, track.count, startMs);
  const i1 = lowerBound(track.t, track.count, endMs);

  // 埋めフレーム数を先に数える
  const gapsBefore = (from: number, to: number) =>
    to - from > fillOver ? Math.floor((to - from) / step) - 1 : 0;
  let total = i1 - i0;
  let prevT = startMs;
  for (let i = i0; i < i1; i++) {
    total += gapsBefore(prevT, track.t[i]);
    prevT = track.t[i];
  }
  total += gapsBefore(prevT, endMs);

  const out: QuestionFrames = {
    count: total,
    t: new Float32Array(total),
    detected: new Uint8Array(total),
    blend: new Float32Array(total * BLEND_COUNT),
    yaw: new Float32Array(total),
    pitch: new Float32Array(total),
    roll: new Float32Array(total),
    rms: new Float32Array(total),
    f0: new Float32Array(total).fill(NaN),
    voiced: new Uint8Array(total),
  };

  let k = 0;
  const fill = (from: number, to: number) => {
    const g = gapsBefore(from, to);
    for (let j = 1; j <= g; j++) {
      out.t[k] = from + j * step;
      k++;
    }
  };
  prevT = startMs;
  for (let i = i0; i < i1; i++) {
    fill(prevT, track.t[i]);
    out.t[k] = track.t[i];
    out.detected[k] = track.detected[i];
    const src = i * BLEND_COUNT;
    const dst = k * BLEND_COUNT;
    for (let b = 0; b < BLEND_COUNT; b++) out.blend[dst + b] = track.blend[src + b] / 255;
    out.yaw[k] = track.yaw[i] / 100;
    out.pitch[k] = track.pitch[i] / 100;
    out.roll[k] = track.roll[i] / 100;
    out.rms[k] = track.rms[i] / 65535;
    prevT = track.t[i];
    k++;
  }
  fill(prevT, endMs);
  return out;
}

/** 正規化された顔の高さ(0〜1)。未検出は 0。 */
export function faceHeightAt(track: FaceTrack, i: number): number {
  if (!track.detected[i]) return 0;
  return Math.max(0, (track.box[i * 4 + 3] - track.box[i * 4 + 1]) / 65535);
}

/** 正準順の blendshape 値(0〜1)。 */
export function blendAt(track: FaceTrack, i: number, index: number): number {
  return track.blend[i * BLEND_COUNT + index] / 255;
}
