// 出力文に推奨/非推奨・性格の断定・感情への言及が含まれないこと(§7 / §13)。

import { describe, expect, it } from "vitest";
import {
  FEATURE_NOTES,
  LOW_CONFIDENCE_MESSAGE,
  PROVISIONAL_NOTE,
  QUADRANT_GUIDES,
} from "../src/config/guides";
import { NORMS, type QuadrantKey, type ScoredFeatureKey } from "../src/config/scoring";
import type { FeatureValues } from "../src/engine/features";
import { buildTemplateGuide, containsForbidden } from "../src/engine/guide";
import { scoreSession } from "../src/engine/scoring";

describe("禁止表現チェック", () => {
  it("象限ガイドの全文がクリーン", () => {
    for (const lines of Object.values(QUADRANT_GUIDES)) {
      for (const line of lines) {
        expect(containsForbidden(line)).toBeNull();
      }
    }
  });

  it("特徴量補足の全文がクリーン", () => {
    for (const note of Object.values(FEATURE_NOTES)) {
      expect(containsForbidden(note.high)).toBeNull();
      expect(containsForbidden(note.low)).toBeNull();
    }
  });

  it("固定文言がクリーン", () => {
    expect(containsForbidden(LOW_CONFIDENCE_MESSAGE)).toBeNull();
    expect(containsForbidden(PROVISIONAL_NOTE)).toBeNull();
  });

  it("違反文は検出される", () => {
    expect(containsForbidden("採用すべきです")).not.toBeNull();
    expect(containsForbidden("明るい性格の人です")).not.toBeNull();
    expect(containsForbidden("緊張していたようです")).not.toBeNull();
  });
});

describe("テンプレート生成", () => {
  it("全象限 × 極端な特徴量の組み合わせでクリーンな文章を生成する", () => {
    const quadrants: QuadrantKey[] = ["sender", "decider", "harmonizer", "thinker"];
    for (const q of quadrants) {
      for (const extreme of [0, 1]) {
        const features = {} as Record<string, number | null>;
        for (const [key, band] of Object.entries(NORMS)) {
          features[key] = extreme === 1 ? band.high : band.low;
        }
        for (const k of ["duchenneRatio", "blinkRate", "voicedRatio", "poseStability", "meanF0"]) {
          features[k] = null;
        }
        const score = scoreSession(
          features as FeatureValues,
          { languageAvailable: true, lexiconReliable: true, faceDetectRate: 1, speechSec: 60 },
          { passed: true, skipped: false },
        );
        const text = buildTemplateGuide(q, score);
        expect(text.length).toBeGreaterThan(60);
        expect(containsForbidden(text)).toBeNull();
        expect(text.split("\n").length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("上位特徴量ごとの補足文はキーごとに存在チェックできる", () => {
    const keys = Object.keys(FEATURE_NOTES) as ScoredFeatureKey[];
    expect(keys.length).toBeGreaterThan(8);
  });
});
