// 運用版の表情集計(src/analysis/expression.ts)。
// 合成プロファイルを「録画中の解析(15fps)」相当の顔トラックに変換して、実際の集計コードパスを通す。

import { describe, expect, it } from "vitest";
import { mulberry32, PROFILES, synthesizeQuestion } from "../scripts/lib/synth";
import { computeExpressionSummary, segmentsFromMarkers } from "../src/analysis/expression";
import { defaultTrackMeta, FaceTrackBuilder, type FaceTrack } from "../src/analysis/faceTrack";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import type { Marker } from "../src/shared/types";

function synthTrack(
  profile: keyof typeof PROFILES,
  seed: number,
  opts: { minutes?: number; gapMs?: [number, number]; faceH?: number; extraFaces?: number } = {},
): FaceTrack {
  const rng = mulberry32(seed);
  const minutes = opts.minutes ?? 3;
  const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
  const h = opts.faceH ?? 0.2;
  let t0 = 0;
  for (let q = 0; q < minutes; q++) {
    const sq = synthesizeQuestion(PROFILES[profile], t0, 60_000, rng);
    // 30fps → 15fps(1フレームおき)
    for (let i = 0; i < sq.frames.count; i += 2) {
      const t = sq.frames.t[i];
      const inGap = opts.gapMs && t >= opts.gapMs[0] && t < opts.gapMs[1];
      const det = sq.frames.detected[i] === 1 && !inGap;
      b.push(
        t,
        det ? 1 + (opts.extraFaces ?? 0) : opts.extraFaces ?? 0,
        det
          ? {
              blend: sq.frames.blend.subarray(i * BLEND_COUNT, (i + 1) * BLEND_COUNT),
              yaw: sq.frames.yaw[i],
              pitch: sq.frames.pitch[i],
              roll: sq.frames.roll[i],
              box: { x0: 0.45, y0: 0.3, x1: 0.45 + h * 0.56, y1: 0.3 + h },
            }
          : null,
      );
    }
    t0 += 60_000;
  }
  return b.build();
}

const marker = (tMs: number, label: string): Marker => ({ id: label, tMs, kind: "question", label });

describe("表情集計", () => {
  it("笑顔・表情の多いプロファイルと少ないプロファイルで総合値に明確な差が出る", () => {
    const hi = computeExpressionSummary(synthTrack("energetic", 1), [], null);
    const lo = computeExpressionSummary(synthTrack("subdued", 2), [], null);
    expect(hi.overall.expressiveness).not.toBeNull();
    expect(lo.overall.expressiveness).not.toBeNull();
    expect(hi.overall.expressiveness! - lo.overall.expressiveness!).toBeGreaterThanOrEqual(25);
    expect(hi.overall.smileRate!).toBeGreaterThan(lo.overall.smileRate!);
    expect(hi.overall.smilePerMin!).toBeGreaterThan(5);
    expect(lo.overall.smilePerMin!).toBeLessThan(3);
    expect(hi.overall.nodRate!).toBeGreaterThan(lo.overall.nodRate!);
  });

  it("同じ条件の2回で総合値の差は10ポイント以内(再現性)", () => {
    const a = computeExpressionSummary(synthTrack("balanced", 10), [], null);
    const b = computeExpressionSummary(synthTrack("balanced", 20), [], null);
    expect(Math.abs(a.overall.expressiveness! - b.overall.expressiveness!)).toBeLessThanOrEqual(10);
  });

  it("質問マーカーで区切った区間ごとに集計する", () => {
    const track = synthTrack("balanced", 3);
    const markers = [marker(20_000, "自己紹介"), marker(70_000, "志望理由"), marker(130_000, "得意なこと")];
    const s = computeExpressionSummary(track, markers, 180_000);
    expect(s.segments.map((x) => x.label)).toEqual(["質問前", "自己紹介", "志望理由", "得意なこと"]);
    expect(s.segments[1].startMs).toBe(20_000);
    expect(s.segments[1].endMs).toBe(70_000);
    expect(s.segments[3].endMs).toBe(180_000);
    for (const seg of s.segments.slice(1)) {
      expect(seg.metrics.smileRate).not.toBeNull();
      expect(seg.metrics.faceDetectRate).toBeGreaterThan(0.9);
    }
  });

  it("区切りの規則: ブックマークは区間を作らない・短すぎる区間は捨てる", () => {
    const segs = segmentsFromMarkers(
      [
        marker(5_000, "Q1"),
        { id: "b", tMs: 8_000, kind: "bookmark", label: "★" },
        marker(30_000, "Q2"),
        marker(30_500, "Q3"),
      ],
      60_000,
    );
    expect(segs.map((s) => s.label)).toEqual(["Q1", "Q3"]);
    expect(segs[0].endMs).toBe(30_000);
  });

  it("顔が映っていない区間を注目シーンに挙げ、計測率に反映する", () => {
    const s = computeExpressionSummary(synthTrack("balanced", 4, { gapMs: [40_000, 52_000] }), [], null);
    const gaps = s.highlights.filter((h) => h.kind === "gap");
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    const g = gaps.find((x) => x.tMs >= 39_000 && x.tMs <= 41_000);
    expect(g).toBeDefined();
    expect(g!.endMs! - g!.tMs).toBeGreaterThan(10_000);
    expect(s.overall.faceDetectRate).toBeLessThan(0.95);
    expect(s.highlights.some((h) => h.kind === "smile")).toBe(true);
    // 時刻順
    for (let i = 1; i < s.highlights.length; i++) {
      expect(s.highlights[i].tMs).toBeGreaterThanOrEqual(s.highlights[i - 1].tMs);
    }
  });

  it("データ品質: 顔が小さい・複数の顔が映る・短いと信頼度が下がる", () => {
    const good = computeExpressionSummary(synthTrack("balanced", 5), [], null);
    expect(good.quality.level).toBe("high");
    expect(good.quality.notes).toEqual([]);

    const small = computeExpressionSummary(synthTrack("balanced", 6, { faceH: 0.05 }), [], null);
    expect(small.quality.level).toBe("low");

    const multi = computeExpressionSummary(synthTrack("balanced", 7, { extraFaces: 1 }), [], null);
    expect(multi.quality.level).toBe("mid");
    expect(multi.quality.notes.join()).toContain("複数の顔");

    const short = computeExpressionSummary(synthTrack("balanced", 8, { minutes: 1 }), [], null);
    expect(short.quality.level).toBe("mid");
  });

  it("顔がまったく取れない録画は品質「低」で、指標は null", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
    for (let t = 0; t < 60_000; t += 66) b.push(t, 0, null);
    const s = computeExpressionSummary(b.build(), [], 60_000);
    expect(s.quality.level).toBe("low");
    expect(s.overall.smileRate).toBeNull();
    expect(s.overall.expressiveness).toBeNull();
    expect(s.overall.faceDetectRate).toBe(0);
  });

  it("下を向いていた割合は録画全体の中央値からの差で判定する(カメラの傾きに依存しない)", () => {
    const mk = (offset: number) => {
      const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 100 }));
      const blend = new Float32Array(BLEND_COUNT);
      for (let i = 0; i < 600; i++) {
        // 20% の時間だけ 25° 下を向く
        const pitch = offset + (i % 10 < 2 ? 25 : 0);
        b.push(i * 100, 1, { blend, yaw: 0, pitch, roll: 0, box: { x0: 0.4, y0: 0.3, x1: 0.5, y1: 0.5 } });
      }
      return computeExpressionSummary(b.build(), [], null);
    };
    expect(mk(0).overall.lookDownRatio).toBeCloseTo(0.2, 2);
    expect(mk(-20).overall.lookDownRatio).toBeCloseTo(0.2, 2);
  });
});

describe("解析が遅い端末", () => {
  it("フレーム間隔が目標より粗くても、通常の間隔を「顔なし」と数えない", () => {
    // 目標は 66ms 間隔だが、実際は 300ms 間隔(毎秒3.3回)でしか解析できなかった
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
    const blend = new Float32Array(BLEND_COUNT);
    for (let t = 0; t < 120_000; t += 300) {
      const inGap = t >= 50_000 && t < 60_000; // 10秒だけ本当に顔がない
      b.push(t, inGap ? 0 : 1, inGap ? null : { blend, yaw: 0, pitch: 0, roll: 0, box: { x0: 0.4, y0: 0.3, x1: 0.5, y1: 0.5 } });
    }
    const s = computeExpressionSummary(b.build(), [], null);
    expect(s.overall.faceDetectRate).toBeGreaterThan(0.88);
    expect(s.overall.faceDetectRate).toBeLessThan(0.94);
    expect(s.overall.detectedSec).toBeGreaterThan(100);
    expect(s.quality.analysisFps).toBeCloseTo(3.3, 1);
    // 速い動きは出さない
    expect(s.overall.nodRate).toBeNull();
    expect(s.overall.blinkRate).toBeNull();
    expect(s.quality.notes.join()).toContain("うなずき");
  });

  it("解析が途中で止まった区間(タブ非表示など)は「顔なし」として埋める", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
    const blend = new Float32Array(BLEND_COUNT);
    for (let t = 0; t < 60_000; t += 70) {
      if (t >= 20_000 && t < 40_000) continue; // 20秒間フレームなし
      b.push(t, 1, { blend, yaw: 0, pitch: 0, roll: 0, box: { x0: 0.4, y0: 0.3, x1: 0.5, y1: 0.5 } });
    }
    const s = computeExpressionSummary(b.build(), [], null);
    expect(s.overall.faceDetectRate).toBeGreaterThan(0.6);
    expect(s.overall.faceDetectRate).toBeLessThan(0.72);
  });
});
