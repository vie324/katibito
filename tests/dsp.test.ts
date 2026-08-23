import { describe, expect, it } from "vitest";
import {
  bandpassZeroCrossings,
  estimateF0,
  matrixToEulerDeg,
  risingEdges,
} from "../src/engine/dsp";

function makeRotationColumnMajor(yawDeg: number, pitchDeg: number, rollDeg: number): number[] {
  const a = (yawDeg * Math.PI) / 180;
  const b = (pitchDeg * Math.PI) / 180;
  const c = (rollDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  // R = Ry(yaw) · Rx(pitch) · Rz(roll)(row-major)
  const R = [
    [ca * cc + sa * sb * sc, -ca * sc + sa * sb * cc, sa * cb],
    [cb * sc, cb * cc, -sb],
    [-sa * cc + ca * sb * sc, sa * sc + ca * sb * cc, ca * cb],
  ];
  // column-major 4x4 に詰める
  const m = new Array<number>(16).fill(0);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) m[col * 4 + row] = R[row][col];
  }
  m[15] = 1;
  return m;
}

describe("頭部姿勢のオイラー角分解(§5.3)", () => {
  it("既知の回転行列を復元できる", () => {
    const m = makeRotationColumnMajor(20, 10, 5);
    const e = matrixToEulerDeg(m);
    expect(e.yaw).toBeCloseTo(20, 3);
    expect(e.pitch).toBeCloseTo(10, 3);
    expect(e.roll).toBeCloseTo(5, 3);
  });

  it("負角も復元できる", () => {
    const e = matrixToEulerDeg(makeRotationColumnMajor(-12, -8, 3));
    expect(e.yaw).toBeCloseTo(-12, 3);
    expect(e.pitch).toBeCloseTo(-8, 3);
    expect(e.roll).toBeCloseTo(3, 3);
  });
});

describe("F0 推定(§5.4 / 付録B-3)", () => {
  const SR = 48_000;

  function sine(freq: number, len = 2048, amp = 0.4): Float32Array {
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    return buf;
  }

  it("純音の周波数を推定できる", () => {
    const f0 = estimateF0(sine(120), SR);
    expect(f0).not.toBeNull();
    expect(f0!).toBeGreaterThan(117);
    expect(f0!).toBeLessThan(123);
  });

  it("2T にも相関ピークが立つ帯域で半分に倒れない(200Hz)", () => {
    const f0 = estimateF0(sine(200), SR);
    expect(f0).not.toBeNull();
    expect(f0!).toBeGreaterThan(195);
    expect(f0!).toBeLessThan(205);
  });

  it("倍音を含む信号で2倍に倒れない(140Hz + 第2倍音)", () => {
    const buf = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      const t = i / SR;
      buf[i] =
        0.4 * Math.sin(2 * Math.PI * 140 * t) + 0.28 * Math.sin(2 * Math.PI * 280 * t + 0.6);
    }
    const f0 = estimateF0(buf, SR);
    expect(f0).not.toBeNull();
    expect(f0!).toBeGreaterThan(135);
    expect(f0!).toBeLessThan(145);
  });

  it("無音は null", () => {
    expect(estimateF0(new Float32Array(2048), SR)).toBeNull();
  });

  it("ノイズは null(相関が閾値未満)", () => {
    const buf = new Float32Array(2048);
    let s = 12345;
    for (let i = 0; i < 2048; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = (s / 0x7fffffff - 0.5) * 0.2;
    }
    expect(estimateF0(buf, SR)).toBeNull();
  });
});

describe("うなずき・まばたきの計数", () => {
  it("1.5Hz の pitch 振動のゼロ交差を数える", () => {
    const fps = 30;
    const seconds = 10;
    const n = fps * seconds;
    const series = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      series[i] = 3 * Math.sin((2 * Math.PI * 1.5 * i) / fps);
    }
    const crossings = bandpassZeroCrossings(series, n, fps);
    // 1.5Hz × 10秒 = 15周期 ≈ 30交差(帯域フィルタの端で多少減る)
    expect(crossings).toBeGreaterThan(18);
    expect(crossings).toBeLessThan(36);
  });

  it("振幅が小さい揺れは数えない", () => {
    const fps = 30;
    const n = fps * 10;
    const series = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      series[i] = 0.2 * Math.sin((2 * Math.PI * 1.5 * i) / fps);
    }
    expect(bandpassZeroCrossings(series, n, fps)).toBe(0);
  });

  it("立ち上がり回数を数える", () => {
    const s = Float32Array.from([0, 0.8, 0.9, 0.1, 0, 0.7, 0.2, 0.9]);
    expect(risingEdges(s, s.length, 0.5)).toBe(3);
  });
});
