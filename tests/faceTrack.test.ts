import { describe, expect, it } from "vitest";
import {
  decodeFaceTrack,
  defaultTrackMeta,
  encodeFaceTrack,
  FaceTrackBuilder,
  trackToFrames,
  TrackFormatError,
} from "../src/analysis/faceTrack";
import { BLEND_COUNT, BS } from "../src/engine/blendshapeNames";

function sampleFace(smile: number) {
  const blend = new Float32Array(BLEND_COUNT);
  blend[BS.smileL] = smile;
  blend[BS.smileR] = smile;
  blend[BS.browInner] = 0.3;
  return { blend, yaw: -12.34, pitch: 5.67, roll: 1.5, box: { x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.55 } };
}

describe("FaceTrack のバイナリ形式", () => {
  it("エンコード → デコードで値が保たれる(量子化誤差の範囲)", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66, hasAudio: true }), 4);
    for (let i = 0; i < 100; i++) {
      b.push(i * 66, i % 10 === 0 ? 2 : 1, i % 7 === 0 ? null : sampleFace((i % 5) / 5), 0.05, i % 3 === 0);
    }
    b.addGap({ startMs: 1000, endMs: 1500, reason: "hidden" });
    const track = b.build();
    const bytes = encodeFaceTrack(track);
    const back = decodeFaceTrack(bytes);

    expect(back.count).toBe(100);
    expect(back.meta.source).toBe("live");
    expect(back.meta.hasAudio).toBe(true);
    expect(back.meta.gaps).toEqual([{ startMs: 1000, endMs: 1500, reason: "hidden" }]);
    expect(Array.from(back.t)).toEqual(Array.from(track.t));
    expect(Array.from(back.detected)).toEqual(Array.from(track.detected));
    expect(back.detected[0]).toBe(0);
    expect(back.detected[1]).toBe(1);
    expect(back.faces[10]).toBe(2);
    expect(back.yaw[1] / 100).toBeCloseTo(-12.34, 2);
    expect(back.pitch[1] / 100).toBeCloseTo(5.67, 2);
    expect(back.box[4] / 65535).toBeCloseTo(0.4, 4);
    expect(back.blend[3 * BLEND_COUNT + BS.smileL] / 255).toBeCloseTo(0.6, 2);
    expect(back.rms[5] / 65535).toBeCloseTo(0.05, 4);
    expect(back.voiced[3]).toBe(1);
  });

  it("壊れたデータは TrackFormatError", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "file" }));
    b.push(0, 1, sampleFace(0.2));
    const bytes = encodeFaceTrack(b.build());
    expect(() => decodeFaceTrack(bytes.subarray(0, bytes.length - 1))).toThrow(TrackFormatError);
    const bad = bytes.slice();
    bad[0] = 0;
    expect(() => decodeFaceTrack(bad)).toThrow(TrackFormatError);
    expect(() => decodeFaceTrack(new Uint8Array(4))).toThrow(TrackFormatError);
  });

  it("時刻が巻き戻るフレームは捨てる", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live" }));
    expect(b.push(100, 1, sampleFace(0))).toBe(true);
    expect(b.push(50, 1, sampleFace(0))).toBe(false);
    expect(b.push(100, 1, sampleFace(0))).toBe(true);
    expect(b.length).toBe(2);
  });
});

describe("trackToFrames(集計用の変換)", () => {
  it("解析が止まっていた区間を「顔なし」フレームで埋める", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 100 }));
    for (let t = 0; t < 2000; t += 100) b.push(t, 1, sampleFace(0.5));
    // 2000〜5000ms は解析なし(タブ非表示)
    for (let t = 5000; t < 7000; t += 100) b.push(t, 1, sampleFace(0.5));
    const frames = trackToFrames(b.build(), 0, 7000);
    const detected = Array.from(frames.detected).reduce((a, v) => a + v, 0);
    expect(detected).toBe(40);
    // 埋めたぶん全体のフレーム数は約70
    expect(frames.count).toBeGreaterThanOrEqual(68);
    expect(frames.count).toBeLessThanOrEqual(70);
    for (let i = 1; i < frames.count; i++) expect(frames.t[i]).toBeGreaterThan(frames.t[i - 1]);
  });

  it("区間の切り出しと値の復元", () => {
    const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 100 }));
    for (let t = 0; t < 3000; t += 100) b.push(t, 1, sampleFace(t >= 1000 && t < 2000 ? 0.8 : 0));
    const frames = trackToFrames(b.build(), 1000, 2000);
    expect(frames.count).toBe(10);
    expect(frames.t[0]).toBe(1000);
    expect(frames.blend[BS.smileL]).toBeCloseTo(0.8, 2);
    expect(frames.pitch[0]).toBeCloseTo(5.67, 2);
    expect(Number.isNaN(frames.f0[0])).toBe(true);
    expect(frames.voiced[0]).toBe(0);
  });
});
