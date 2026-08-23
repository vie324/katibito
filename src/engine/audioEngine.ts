// 音響シグナル(§5.4): AnalyserNode から RMS / F0 / VAD。外部ライブラリなし。

import { SIGNAL } from "../config/scoring";
import { computeRms, estimateF0, peakAbs } from "./dsp";

export type AudioTick = {
  rms: number;
  /** Hz。無声時 null */
  f0: number | null;
  voiced: boolean;
  /** クリップ検出用の絶対ピーク(環境チェックで使う) */
  peak: number;
};

export class AudioEngine {
  readonly waveform: Float32Array<ArrayBuffer>;
  readonly sampleRate: number;

  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;

  private noiseFloor: number = SIGNAL.NOISE_FLOOR_INIT;
  private voicedState = false;
  private lastAboveEndThr = 0;

  private constructor(ctx: AudioContext, source: MediaStreamAudioSourceNode, analyser: AnalyserNode) {
    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.sampleRate = ctx.sampleRate;
    this.waveform = new Float32Array(analyser.fftSize);
  }

  static async create(stream: MediaStream): Promise<AudioEngine> {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    return new AudioEngine(ctx, source, analyser);
  }

  get currentNoiseFloor(): number {
    return this.noiseFloor;
  }

  /**
   * VAD(§5.4): 開始閾値 > 終了閾値のヒステリシス + 200ms ハングオーバー。
   * ノイズフロアは無声時にゆっくり適応する。
   */
  tick(nowMs: number): AudioTick {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.analyser.getFloatTimeDomainData(this.waveform);
    const rms = computeRms(this.waveform);
    const peak = peakAbs(this.waveform);

    const startThr = Math.max(this.noiseFloor * SIGNAL.VAD_START_MULT, SIGNAL.VAD_ABS_MIN_RMS);
    const endThr = Math.max(this.noiseFloor * SIGNAL.VAD_END_MULT, SIGNAL.VAD_ABS_MIN_RMS * 0.7);

    if (!this.voicedState) {
      if (rms > startThr) {
        this.voicedState = true;
        this.lastAboveEndThr = nowMs;
      }
    } else {
      if (rms > endThr) {
        this.lastAboveEndThr = nowMs;
      } else if (nowMs - this.lastAboveEndThr > SIGNAL.VAD_HANGOVER_MS) {
        this.voicedState = false;
      }
    }

    if (!this.voicedState) {
      this.noiseFloor = Math.min(
        SIGNAL.NOISE_FLOOR_MAX,
        Math.max(SIGNAL.NOISE_FLOOR_MIN, this.noiseFloor * 0.98 + rms * 0.02),
      );
    }

    const f0 = this.voicedState ? estimateF0(this.waveform, this.sampleRate) : null;
    return { rms, f0, voiced: this.voicedState, peak };
  }

  /** 環境チェック時に静かな区間の RMS でノイズフロアを初期化する。 */
  calibrateNoiseFloor(quietRms: number): void {
    this.noiseFloor = Math.min(
      SIGNAL.NOISE_FLOOR_MAX,
      Math.max(SIGNAL.NOISE_FLOOR_MIN, quietRms),
    );
  }

  close(): void {
    this.source.disconnect();
    void this.ctx.close();
  }
}
