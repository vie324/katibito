import { describe, expect, it } from "vitest";
import { NORMS, WEIGHTS } from "../src/config/scoring";
import type { FeatureValues } from "../src/engine/features";
import {
  computeConfidence,
  normalizeValue,
  quadrantOf,
  scoreAxis,
} from "../src/engine/scoring";

function emptyFeatures(): FeatureValues {
  const out = {} as Record<string, number | null>;
  for (const k of Object.keys(NORMS)) out[k] = null;
  for (const k of ["duchenneRatio", "blinkRate", "voicedRatio", "poseStability", "meanF0"]) {
    out[k] = null;
  }
  return out as FeatureValues;
}

describe("正規化(§6.1)", () => {
  it("帯域を 0-100 に線形マップし範囲外はクリップする", () => {
    expect(normalizeValue("charPerMin", 240)).toBe(0);
    expect(normalizeValue("charPerMin", 420)).toBe(100);
    expect(normalizeValue("charPerMin", 330)).toBeCloseTo(50, 5);
    expect(normalizeValue("charPerMin", 100)).toBe(0);
    expect(normalizeValue("charPerMin", 900)).toBe(100);
  });

  it("invert: true は反転する", () => {
    expect(normalizeValue("responseLatencyMs", 300)).toBe(100);
    expect(normalizeValue("responseLatencyMs", 2500)).toBe(0);
    expect(normalizeValue("hedgeRate", 0.1)).toBe(100);
  });
});

describe("軸スコア(§6.2)", () => {
  it("重みは各軸で合計 1.0", () => {
    for (const axis of ["assertiveness", "expressiveness"] as const) {
      const sum = Object.values(WEIGHTS[axis]).reduce((a, b) => a + (b ?? 0), 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it("欠測特徴量は重みゼロで再正規化する", () => {
    const f = emptyFeatures();
    f.rmsMean = 0.12; // norm 100
    const axis = scoreAxis("assertiveness", f, { lexiconReliable: true });
    expect(axis.score).toBeCloseTo(100, 5);
    expect(axis.usedWeightSum).toBeCloseTo(0.12, 10);
  });

  it("全特徴量欠測なら score は null", () => {
    const axis = scoreAxis("assertiveness", emptyFeatures(), { lexiconReliable: true });
    expect(axis.score).toBeNull();
  });

  it("辞書が信頼できないときは辞書特徴量を除外する", () => {
    const f = emptyFeatures();
    f.rmsMean = 0.12; // norm 100
    f.assertionRate = 0.55; // norm 100 だが除外される
    f.hedgeRate = 0.1;
    const withLex = scoreAxis("assertiveness", f, { lexiconReliable: true });
    const withoutLex = scoreAxis("assertiveness", f, { lexiconReliable: false });
    expect(withLex.usedWeightSum).toBeCloseTo(0.42, 10);
    expect(withoutLex.usedWeightSum).toBeCloseTo(0.12, 10);
    const excluded = withoutLex.contributions.find((c) => c.key === "assertionRate");
    expect(excluded?.excludedReason).toBe("lexicon-unreliable");
  });

  it("寄与(points)の合計が軸スコアに一致する", () => {
    const f = emptyFeatures();
    f.rmsMean = 0.07;
    f.responseLatencyMs = 800;
    f.charPerMin = 350;
    const axis = scoreAxis("assertiveness", f, { lexiconReliable: true });
    const sum = axis.contributions.reduce((a, c) => a + (c.points ?? 0), 0);
    expect(sum).toBeCloseTo(axis.score ?? -1, 6);
  });
});

describe("象限(§6.4)", () => {
  it("2軸の高低で4象限に割れる", () => {
    expect(quadrantOf(70, 70)).toBe("sender");
    expect(quadrantOf(70, 30)).toBe("decider");
    expect(quadrantOf(30, 70)).toBe("harmonizer");
    expect(quadrantOf(30, 30)).toBe("thinker");
  });
});

describe("確信度(§6.5)", () => {
  const base = {
    faceDetectRate: 1,
    speechSec: 60,
    assertiveness: 75,
    expressiveness: 75,
    gatePassed: true,
    gateSkipped: false,
    languageAvailable: true,
  };

  it("すべて良好なら高", () => {
    const c = computeConfidence(base);
    expect(c.value).toBeCloseTo(1, 5);
    expect(c.label).toBe("high");
  });

  it("min() を取る: 中央付近は確信度が下がる", () => {
    const c = computeConfidence({ ...base, assertiveness: 55, expressiveness: 80 });
    expect(c.value).toBeCloseTo(5 / 25, 5);
    expect(c.label).toBe("low");
  });

  it("発話が短いと下がる", () => {
    const c = computeConfidence({ ...base, speechSec: 6 });
    expect(c.value).toBeCloseTo(0.2, 5);
    expect(c.label).toBe("low");
  });

  it("環境チェック不合格は 0.4 で頭打ち", () => {
    const c = computeConfidence({ ...base, gatePassed: false });
    expect(c.value).toBeCloseTo(0.4, 5);
    expect(c.label).toBe("mid");
  });

  it("言語特徴なしは1段下がる", () => {
    const c = computeConfidence({ ...base, languageAvailable: false });
    expect(c.label).toBe("mid");
  });

  it("チェックを無視して開始した場合は強制的に低(§4)", () => {
    const c = computeConfidence({ ...base, gatePassed: false, gateSkipped: true });
    expect(c.label).toBe("low");
  });
});
