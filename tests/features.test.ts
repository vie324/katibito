import { describe, expect, it } from "vitest";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import { analyzeQuestion } from "../src/engine/features";
import type { QuestionFrames } from "../src/engine/ringBuffer";

const FPS = 30;
const DT = 1000 / FPS;

function makeFrames(n: number, shownAt = 0): QuestionFrames {
  const f: QuestionFrames = {
    count: n,
    t: new Float32Array(n),
    detected: new Uint8Array(n).fill(1),
    blend: new Float32Array(n * BLEND_COUNT),
    yaw: new Float32Array(n),
    pitch: new Float32Array(n),
    roll: new Float32Array(n),
    rms: new Float32Array(n),
    f0: new Float32Array(n).fill(NaN),
    voiced: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) f.t[i] = shownAt + i * DT;
  return f;
}

function setVoiced(f: QuestionFrames, fromMs: number, toMs: number, rms = 0.06): void {
  for (let i = 0; i < f.count; i++) {
    const rel = i * DT;
    if (rel >= fromMs && rel < toMs) {
      f.voiced[i] = 1;
      f.rms[i] = rms;
      f.f0[i] = 120;
    }
  }
}

describe("特徴量抽出(§5)", () => {
  it("応答潜時: 300ms 継続した最初の発話立ち上がりまで", () => {
    const f = makeFrames(FPS * 20);
    // 500ms に短い発話(200ms)、1200ms から本発話
    setVoiced(f, 500, 700);
    setVoiced(f, 1200, 8000);
    const a = analyzeQuestion(f, [], 0, false);
    expect(a.features.responseLatencyMs).not.toBeNull();
    expect(a.features.responseLatencyMs!).toBeGreaterThan(1100);
    expect(a.features.responseLatencyMs!).toBeLessThan(1350);
  });

  it("平均ポーズ長: 発話区間内の 200ms 以上の無声区間", () => {
    const f = makeFrames(FPS * 20);
    setVoiced(f, 0, 4000);
    setVoiced(f, 4600, 8000); // 600ms ポーズ
    setVoiced(f, 8100, 12000); // 100ms は数えない
    const a = analyzeQuestion(f, [], 0, false);
    expect(a.features.meanPauseMs).not.toBeNull();
    expect(a.features.meanPauseMs!).toBeGreaterThan(500);
    expect(a.features.meanPauseMs!).toBeLessThan(700);
  });

  it("笑顔頻度と強度", () => {
    const f = makeFrames(FPS * 10);
    const smileL = 44, smileR = 45; // 正準順
    for (let i = 0; i < f.count; i++) {
      const on = i < f.count * 0.3; // 30% のフレームで笑顔
      f.blend[i * BLEND_COUNT + smileL] = on ? 0.5 : 0.05;
      f.blend[i * BLEND_COUNT + smileR] = on ? 0.5 : 0.05;
    }
    const a = analyzeQuestion(f, [], 0, false);
    expect(a.features.smileRate!).toBeCloseTo(0.3, 1);
    expect(a.features.smileIntensity!).toBeCloseTo(0.5, 1);
  });

  it("発話がなければ音響特徴は null", () => {
    const f = makeFrames(FPS * 10);
    const a = analyzeQuestion(f, [], 0, false);
    expect(a.features.rmsMean).toBeNull();
    expect(a.features.responseLatencyMs).toBeNull();
    expect(a.features.charPerMin).toBeNull();
    expect(a.flags.speechSec).toBe(0);
  });

  it("音声認識オフなら言語特徴は null", () => {
    const f = makeFrames(FPS * 10);
    setVoiced(f, 0, 9000);
    const a = analyzeQuestion(f, ["必ずやります。私は決めました。"], 0, false);
    expect(a.features.assertionRate).toBeNull();
    expect(a.flags.languageAvailable).toBe(false);
  });

  it("文字数が少なすぎる場合は言語特徴を無効化(認識失敗扱い)", () => {
    const f = makeFrames(FPS * 10);
    setVoiced(f, 0, 9000);
    const a = analyzeQuestion(f, ["はい。"], 0, true);
    expect(a.flags.languageAvailable).toBe(false);
    expect(a.features.charPerMin).toBeNull();
  });

  it("顔未検出フレームは欠測として表情の分母から外す", () => {
    const f = makeFrames(FPS * 10);
    const smileL = 44, smileR = 45;
    for (let i = 0; i < f.count; i++) {
      f.detected[i] = i % 2 === 0 ? 1 : 0; // 半分欠測
      f.blend[i * BLEND_COUNT + smileL] = 0.5;
      f.blend[i * BLEND_COUNT + smileR] = 0.5;
    }
    const a = analyzeQuestion(f, [], 0, false);
    expect(a.flags.faceDetectRate).toBeCloseTo(0.5, 2);
    expect(a.features.smileRate!).toBeCloseTo(1.0, 2); // 検出フレーム中は全部笑顔
  });
});
