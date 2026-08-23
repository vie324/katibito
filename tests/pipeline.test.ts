// 受入基準(§13)の識別力・再現性を、合成プロファイルで実パイプラインに対して検証する。
// - 無表情・小声 vs 大声・笑顔多め → 両軸で 25 ポイント以上の差
// - 同一条件2回 → 軸スコア差 10 ポイント以内

import { describe, expect, it } from "vitest";
import { mulberry32, PROFILES, synthesizeQuestion } from "../scripts/lib/synth";
import { aggregateAnalyses, analyzeQuestion, type Analysis } from "../src/engine/features";
import { scoreSession } from "../src/engine/scoring";

function runProfile(profile: keyof typeof PROFILES, seed: number) {
  const rng = mulberry32(seed);
  const analyses: Analysis[] = [];
  let t = 3000;
  for (let qi = 0; qi < 3; qi++) {
    const sq = synthesizeQuestion(PROFILES[profile], t, 60_000, rng);
    analyses.push(
      analyzeQuestion(sq.frames, sq.segments.map((s) => s.text), sq.shownAtMs, true),
    );
    t = sq.endAtMs + 2_000;
  }
  const agg = aggregateAnalyses(analyses, true);
  const score = scoreSession(agg.features, agg.flags, { passed: true, skipped: false });
  expect(score.assertiveness.score).not.toBeNull();
  expect(score.expressiveness.score).not.toBeNull();
  return {
    a: score.assertiveness.score!,
    e: score.expressiveness.score!,
    confidence: score.confidence,
    quadrant: score.quadrant,
    flags: agg.flags,
  };
}

describe("識別力(§13)", () => {
  it("大声・笑顔多め と 小声・無表情 で両軸 25pt 以上の差", () => {
    const hi = runProfile("energetic", 11);
    const lo = runProfile("subdued", 22);
    expect(hi.a - lo.a).toBeGreaterThanOrEqual(25);
    expect(hi.e - lo.e).toBeGreaterThanOrEqual(25);
  });

  it("高プロファイルは高い側、低プロファイルは低い側に振れる", () => {
    const hi = runProfile("energetic", 33);
    const lo = runProfile("subdued", 44);
    expect(hi.a).toBeGreaterThan(50);
    expect(hi.e).toBeGreaterThan(50);
    expect(lo.a).toBeLessThan(50);
    expect(lo.e).toBeLessThan(50);
    expect(hi.quadrant).toBe("sender");
    expect(lo.quadrant).toBe("thinker");
  });
});

describe("再現性(§13)", () => {
  it.each([
    ["energetic", 101, 202],
    ["subdued", 303, 404],
    ["balanced", 505, 606],
  ] as const)("%s: 2回の実行で軸スコア差 10pt 以内", (profile, s1, s2) => {
    const r1 = runProfile(profile, s1);
    const r2 = runProfile(profile, s2);
    expect(Math.abs(r1.a - r2.a)).toBeLessThanOrEqual(10);
    expect(Math.abs(r1.e - r2.e)).toBeLessThanOrEqual(10);
  });
});

describe("確信度・言語フラグ", () => {
  it("十分な発話・追跡があれば言語特徴が有効", () => {
    const r = runProfile("balanced", 7);
    expect(r.flags.languageAvailable).toBe(true);
    expect(r.flags.lexiconReliable).toBe(true);
    expect(r.flags.speechSec).toBeGreaterThan(30);
  });
});
