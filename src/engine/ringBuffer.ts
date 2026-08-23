// Float32Array ベースの固定長リングバッファ(§5.1 / §9-4)。
// 配列の push/shift は使わない。ホットパスでのアロケーションもしない。

import { BLEND_COUNT } from "./blendshapeNames";

/** リングのスナップショット。設問終了時に古い順へ並べ直した線形配列。 */
export type QuestionFrames = {
  count: number;
  /** セッション開始からの ms */
  t: Float32Array;
  detected: Uint8Array;
  /** count × 52、正準順 */
  blend: Float32Array;
  yaw: Float32Array;
  pitch: Float32Array;
  roll: Float32Array;
  rms: Float32Array;
  /** NaN = 無声(null 相当) */
  f0: Float32Array;
  voiced: Uint8Array;
};

export class FrameRing {
  readonly capacity: number;
  private head = 0; // 次に書く位置
  private len = 0;

  private readonly t: Float32Array;
  private readonly detected: Uint8Array;
  private readonly blend: Float32Array;
  private readonly yaw: Float32Array;
  private readonly pitch: Float32Array;
  private readonly roll: Float32Array;
  private readonly rms: Float32Array;
  private readonly f0: Float32Array;
  private readonly voiced: Uint8Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.t = new Float32Array(capacity);
    this.detected = new Uint8Array(capacity);
    this.blend = new Float32Array(capacity * BLEND_COUNT);
    this.yaw = new Float32Array(capacity);
    this.pitch = new Float32Array(capacity);
    this.roll = new Float32Array(capacity);
    this.rms = new Float32Array(capacity);
    this.f0 = new Float32Array(capacity);
    this.voiced = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }

  /** blend は正準順の Float32Array(52)。detected=false のときは null 可。 */
  push(
    t: number,
    detected: boolean,
    blend: Float32Array | null,
    yaw: number,
    pitch: number,
    roll: number,
    rms: number,
    f0: number | null,
    voiced: boolean,
  ): void {
    const i = this.head;
    this.t[i] = t;
    this.detected[i] = detected ? 1 : 0;
    if (detected && blend) {
      this.blend.set(blend, i * BLEND_COUNT);
    } else {
      this.blend.fill(0, i * BLEND_COUNT, (i + 1) * BLEND_COUNT);
    }
    this.yaw[i] = yaw;
    this.pitch[i] = pitch;
    this.roll[i] = roll;
    this.rms[i] = rms;
    this.f0[i] = f0 === null ? NaN : f0;
    this.voiced[i] = voiced ? 1 : 0;
    this.head = (i + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
  }

  /** 論理インデックス(0 = いちばん古い)→ 物理インデックス */
  private phys(i: number): number {
    const start = (this.head - this.len + this.capacity * 2) % this.capacity;
    return (start + i) % this.capacity;
  }

  tAt(i: number): number {
    return this.t[this.phys(i)];
  }

  /** 新しい方から n 件(または t が sinceT 以降)を古い順に走査する。 */
  forEachRecent(
    sinceT: number,
    fn: (
      t: number,
      detected: boolean,
      blendBase: number, // this.blendData の先頭オフセット
      yaw: number,
      pitch: number,
      roll: number,
      rms: number,
      f0: number, // NaN = null
      voiced: boolean,
    ) => void,
  ): void {
    // 二分探索は不要(最大1800件の線形走査で十分軽い)
    for (let i = 0; i < this.len; i++) {
      const p = this.phys(i);
      const t = this.t[p];
      if (t < sinceT) continue;
      fn(
        t,
        this.detected[p] === 1,
        p * BLEND_COUNT,
        this.yaw[p],
        this.pitch[p],
        this.roll[p],
        this.rms[p],
        this.f0[p],
        this.voiced[p] === 1,
      );
    }
  }

  /** blend 生データ(forEachRecent の blendBase と併用) */
  get blendData(): Float32Array {
    return this.blend;
  }

  /** 古い順に並べ直した線形コピー。設問終了時に1回だけ呼ぶ。 */
  snapshot(): QuestionFrames {
    const n = this.len;
    const out: QuestionFrames = {
      count: n,
      t: new Float32Array(n),
      detected: new Uint8Array(n),
      blend: new Float32Array(n * BLEND_COUNT),
      yaw: new Float32Array(n),
      pitch: new Float32Array(n),
      roll: new Float32Array(n),
      rms: new Float32Array(n),
      f0: new Float32Array(n),
      voiced: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const p = this.phys(i);
      out.t[i] = this.t[p];
      out.detected[i] = this.detected[p];
      out.blend.set(
        this.blend.subarray(p * BLEND_COUNT, (p + 1) * BLEND_COUNT),
        i * BLEND_COUNT,
      );
      out.yaw[i] = this.yaw[p];
      out.pitch[i] = this.pitch[p];
      out.roll[i] = this.roll[p];
      out.rms[i] = this.rms[p];
      out.f0[i] = this.f0[p];
      out.voiced[i] = this.voiced[p];
    }
    return out;
  }
}

/** 単純な数値リング(トレイルや F0 履歴用)。 */
export class FloatRing {
  private readonly buf: Float32Array;
  private head = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
  }

  get length(): number {
    return this.len;
  }

  /** 論理インデックス 0 = いちばん古い */
  at(i: number): number {
    const start = (this.head - this.len + this.capacity * 2) % this.capacity;
    return this.buf[(start + i) % this.capacity];
  }

  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}
