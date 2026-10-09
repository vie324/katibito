import { describe, expect, it } from "vitest";
import { CandidateTracker, pickBoxAt, type Box } from "../src/analysis/candidate";

const box = (cx: number, cy: number, h: number): Box => ({
  x0: cx - (h * 9) / 16 / 2,
  x1: cx + (h * 9) / 16 / 2,
  y0: cy - h / 2,
  y1: cy + h / 2,
});

describe("候補者の顔の追跡", () => {
  it("未選択なら最も大きい顔を選ぶ", () => {
    const tr = new CandidateTracker();
    const idx = tr.pick([box(0.2, 0.5, 0.1), box(0.6, 0.5, 0.25), box(0.9, 0.5, 0.12)], 0);
    expect(idx).toBe(1);
    expect(tr.current?.cx).toBeCloseTo(0.6);
  });

  it("選んだ顔を追い続け、より大きい別の顔が入っても乗り換えない", () => {
    const tr = new CandidateTracker();
    tr.setTarget(0.3, 0.5, 0.15);
    let t = 0;
    // 候補者は少しずつ右へ動く。途中から面接官の大きな顔(0.8)が映り込む
    for (let k = 0; k < 30; k++) {
      t += 66;
      const cand = box(0.3 + k * 0.005, 0.5, 0.15);
      const boxes = k > 10 ? [box(0.8, 0.45, 0.3), cand] : [cand];
      const idx = tr.pick(boxes, t);
      expect(idx).toBe(boxes.length - 1);
    }
  });

  it("見失っても、遠くの別人には乗り換えない。元の位置の近くで再捕捉する", () => {
    const tr = new CandidateTracker({ reacquireAfterMs: 1000 });
    tr.setTarget(0.3, 0.5, 0.15);
    expect(tr.pick([box(0.3, 0.5, 0.15)], 0)).toBe(0);
    // 候補者が画面外。面接官の顔だけが映る
    expect(tr.pick([box(0.85, 0.5, 0.2)], 100)).toBe(-1);
    expect(tr.pick([box(0.85, 0.5, 0.2)], 3000)).toBe(-1);
    expect(tr.isLost).toBe(true);
    // 少し離れた位置(顔1.2個ぶん以上)に戻ってきた → 一定時間後に再捕捉
    expect(tr.pick([box(0.85, 0.5, 0.2), box(0.45, 0.55, 0.15)], 3100)).toBe(1);
    expect(tr.isLost).toBe(false);
  });

  it("顔がない間は -1", () => {
    const tr = new CandidateTracker();
    expect(tr.pick([], 0)).toBe(-1);
  });

  it("クリック位置の顔を選べる", () => {
    const boxes = [box(0.2, 0.5, 0.1), box(0.6, 0.5, 0.25)];
    expect(pickBoxAt(boxes, 0.2, 0.5)).toBe(0);
    expect(pickBoxAt(boxes, 0.62, 0.45)).toBe(1);
    expect(pickBoxAt(boxes, 0.35, 0.9)).toBe(0);
    expect(pickBoxAt([], 0.5, 0.5)).toBe(-1);
  });
});
