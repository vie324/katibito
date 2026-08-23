// 純粋な信号処理ユーティリティ。DOM に依存しない(Node のテスト・サンプル生成からも使う)。

import { SIGNAL } from "../config/scoring";

export function mean(xs: ArrayLike<number>, count = xs.length): number {
  if (count === 0) return 0;
  let s = 0;
  for (let i = 0; i < count; i++) s += xs[i];
  return s / count;
}

export function std(xs: ArrayLike<number>, count = xs.length): number {
  if (count < 2) return 0;
  const m = mean(xs, count);
  let s = 0;
  for (let i = 0; i < count; i++) {
    const d = xs[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / count);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function computeRms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export function peakAbs(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * 自己相関による F0 推定(§5.4)。
 * - 探索範囲 F0_MIN_HZ〜F0_MAX_HZ
 * - 正規化ピーク相関が F0_MIN_CORR 未満なら null
 * - オクターブエラー対策(付録B-3): 周期 T の信号は 2T, 3T でも相関が高く出るため、
 *   グローバル最大を取るのではなく「最大値 × F0_OCTAVE_TOL 以上の最初(最小ラグ側)の
 *   局所ピーク」を基本周期として採る。倍音由来の T/2 ピークは通常この閾値に届かない。
 */
const corrScratch = new Float32Array(2048);

export function estimateF0(buf: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / SIGNAL.F0_MAX_HZ);
  const maxLag = Math.ceil(sampleRate / SIGNAL.F0_MIN_HZ);
  const n = buf.length - maxLag;
  if (n < 64) return null;

  // 基準エネルギー
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += buf[i] * buf[i];
  if (e0 < 1e-9) return null;

  const corrAt = (lag: number): number => {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i < n; i++) {
      c += buf[i] * buf[i + lag];
      e1 += buf[i + lag] * buf[i + lag];
    }
    const denom = Math.sqrt(e0 * e1);
    return denom > 1e-9 ? c / denom : 0;
  };

  // 粗い探索(2サンプル刻み)で相関列を作る
  const step = 2;
  const count = Math.floor((maxLag - minLag) / step) + 1;
  let globalMax = -1;
  let globalIdx = 0;
  for (let k = 0; k < count; k++) {
    const c = corrAt(minLag + k * step);
    corrScratch[k] = c;
    if (c > globalMax) {
      globalMax = c;
      globalIdx = k;
    }
  }
  if (globalMax < SIGNAL.F0_MIN_CORR) return null;

  // 最初の有意な局所ピークを基本周期とする
  const threshold = globalMax * SIGNAL.F0_OCTAVE_TOL;
  let pick = -1;
  for (let k = 0; k < count; k++) {
    const c = corrScratch[k];
    if (c < threshold) continue;
    const prev = k > 0 ? corrScratch[k - 1] : -1;
    const next = k < count - 1 ? corrScratch[k + 1] : -1;
    if (c >= prev && c >= next) {
      pick = k;
      break;
    }
  }
  if (pick < 0) pick = globalIdx;

  // 近傍を1サンプル刻みで精査
  const coarseLag = minLag + pick * step;
  let bestLag = coarseLag;
  let bestCorr = corrScratch[pick];
  for (
    let lag = Math.max(minLag, coarseLag - step);
    lag <= Math.min(maxLag, coarseLag + step);
    lag++
  ) {
    const c = corrAt(lag);
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  if (bestCorr < SIGNAL.F0_MIN_CORR) return null;

  // 放物線補間でサブサンプル精度に
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const c0 = corrAt(bestLag - 1);
    const c1 = bestCorr;
    const c2 = corrAt(bestLag + 1);
    const denom = c0 - 2 * c1 + c2;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (c0 - c2)) / denom;
      if (Math.abs(delta) < 1) lag = bestLag + delta;
    }
  }
  return sampleRate / lag;
}

/**
 * 4x4 column-major 行列(facialTransformationMatrixes[0].data)の回転部分を
 * オイラー角(度)に分解する。分解順 R = Ry(yaw) · Rx(pitch) · Rz(roll)。
 * 符号は実機検証のうえ config/scoring.ts の SIGNS で吸収する(付録B-1)。
 */
export function matrixToEulerDeg(m: ArrayLike<number>): {
  yaw: number;
  pitch: number;
  roll: number;
} {
  // column-major: R[row][col] = m[col*4 + row]
  const r02 = m[8];
  const r22 = m[10];
  const r12 = m[9];
  const r10 = m[1];
  const r11 = m[5];
  const toDeg = 180 / Math.PI;
  return {
    yaw: Math.atan2(r02, r22) * toDeg,
    pitch: Math.asin(clamp(-r12, -1, 1)) * toDeg,
    roll: Math.atan2(r10, r11) * toDeg,
  };
}

/**
 * nodRate 用の帯域通過(§5.3)。移動平均の差分で 0.5〜3.0Hz 相当を取り出し、
 * 最小振幅 NOD_MIN_DEG を超えたスイングのゼロ交差だけ数える。
 * 戻り値は交差回数(呼び出し側で /分 に換算する)。
 */
export function bandpassZeroCrossings(
  series: ArrayLike<number>,
  count: number,
  fps: number,
): number {
  if (count < 8) return 0;
  const shortWin = Math.max(1, Math.round(fps / (2 * SIGNAL.NOD_BAND_HIGH_HZ)));
  const longWin = Math.max(shortWin + 1, Math.round(fps / (2 * SIGNAL.NOD_BAND_LOW_HZ)));

  const maShort = movingAverage(series, count, shortWin);
  const maLong = movingAverage(series, count, longWin);

  let crossings = 0;
  let prevSign = 0;
  let swing = 0;
  for (let i = 0; i < count; i++) {
    const v = maShort[i] - maLong[i];
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    swing = Math.max(swing, Math.abs(v));
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      if (swing >= SIGNAL.NOD_MIN_DEG) crossings++;
      swing = Math.abs(v);
    }
    if (sign !== 0) prevSign = sign;
  }
  return crossings;
}

function movingAverage(xs: ArrayLike<number>, count: number, win: number): Float32Array {
  const out = new Float32Array(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += xs[i];
    if (i >= win) acc -= xs[i - win];
    out[i] = acc / Math.min(i + 1, win);
  }
  return out;
}

/** 立ち上がり(閾値を下から上に跨いだ回数)を数える。blinkRate 用(§5.2)。 */
export function risingEdges(
  series: ArrayLike<number>,
  count: number,
  threshold: number,
): number {
  let edges = 0;
  let above = false;
  for (let i = 0; i < count; i++) {
    const a = series[i] > threshold;
    if (a && !above) edges++;
    above = a;
  }
  return edges;
}

/** 指数移動平均。ライブ値(§6.3)に使う。 */
export class Ema {
  private v: number | null = null;
  constructor(private readonly alpha: number) {}
  push(x: number): number {
    this.v = this.v === null ? x : this.v + this.alpha * (x - this.v);
    return this.v;
  }
  get value(): number | null {
    return this.v;
  }
  reset(): void {
    this.v = null;
  }
}
