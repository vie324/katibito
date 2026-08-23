import { describe, expect, it } from "vitest";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import { FloatRing, FrameRing } from "../src/engine/ringBuffer";

function pushN(ring: FrameRing, n: number, startT = 0): void {
  const blend = new Float32Array(BLEND_COUNT);
  for (let i = 0; i < n; i++) {
    blend[0] = startT + i; // マーカー
    ring.push(startT + i * 33, true, blend, 1, 2, 3, 0.05, 120, true);
  }
}

describe("FrameRing(§9-4)", () => {
  it("容量まで積める", () => {
    const ring = new FrameRing(100);
    pushN(ring, 50);
    expect(ring.length).toBe(50);
  });

  it("容量を超えると古いものから上書きされる", () => {
    const ring = new FrameRing(100);
    pushN(ring, 150);
    expect(ring.length).toBe(100);
    const snap = ring.snapshot();
    expect(snap.count).toBe(100);
    // いちばん古いフレームは 50 番目(t = 50*33)
    expect(snap.t[0]).toBe(50 * 33);
    expect(snap.t[99]).toBe(149 * 33);
    // blend もフレームに対応してずれない
    expect(snap.blend[0]).toBe(50);
    expect(snap.blend[99 * BLEND_COUNT]).toBe(149);
  });

  it("clear で空になる", () => {
    const ring = new FrameRing(10);
    pushN(ring, 5);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.snapshot().count).toBe(0);
  });

  it("forEachRecent は sinceT 以降を古い順に走査する", () => {
    const ring = new FrameRing(100);
    pushN(ring, 100);
    const ts: number[] = [];
    ring.forEachRecent(50 * 33, (t) => ts.push(t));
    expect(ts[0]).toBe(50 * 33);
    expect(ts.length).toBe(50);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });
});

describe("FloatRing", () => {
  it("wraparound しても順序が正しい", () => {
    const ring = new FloatRing(4);
    for (let i = 0; i < 6; i++) ring.push(i);
    expect(ring.length).toBe(4);
    expect(ring.at(0)).toBe(2);
    expect(ring.at(3)).toBe(5);
  });
});
