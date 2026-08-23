// Session の組み立てと JSON 書き出し(§8)、およびセッション進行の状態管理。
// デモ1回 = キャリブレーション用データ1件。normsVersion と groundTruth 枠を必ず入れる。

import { APP_VERSION } from "../config/flags";
import type { Question } from "../config/questions";
import { LIVE, NORMS_VERSION, SIGNAL } from "../config/scoring";
import { BLEND_COUNT, BS } from "./blendshapeNames";
import { bandpassZeroCrossings, Ema } from "./dsp";
import {
  addLexCounts,
  aggregateAnalyses,
  analyzeQuestion,
  analyzeSegment,
  emptyLexCounts,
  type Analysis,
  type FeatureValues,
  type LexCounts,
} from "./features";
import { FloatRing, FrameRing, type QuestionFrames } from "./ringBuffer";
import { liveAxes, scoreSession, type ScoreResult } from "./scoring";

// ---------------------------------------------------------------------------
// §8 データモデル
// ---------------------------------------------------------------------------

export type GateInfo = {
  passed: boolean;
  /** 「チェックを無視して開始」したか */
  skipped: boolean;
  results: Record<string, boolean>;
  speechRecognitionUsed: boolean;
};

export type Session = {
  sessionId: string;
  recordedAt: string;
  appVersion: string;
  environment: {
    gatePassed: boolean;
    gateResults: Record<string, boolean>;
    device: string;
    speechRecognitionUsed: boolean;
  };
  questions: {
    questionId: string;
    text: string;
    durationMs: number;
    transcript: string;
    features: Record<string, number | null>;
  }[];
  aggregate: {
    features: Record<string, number | null>;
    assertiveness: number | null;
    expressiveness: number | null;
    quadrant: string;
    confidence: "high" | "mid" | "low";
  };
  normsVersion: string;
  /** あとから他者評価を追記するための枠。ツール側では常に null */
  groundTruth: null;
};

/** タイムライン・リプレイ用の時系列(約10Hz)。JSON化のため NaN は使わない。 */
export type SeriesSet = {
  t: number[];
  rms: number[];
  /** 無声時 0 */
  f0: number[];
  smile: number[];
  brow: number[];
  pitch: number[];
  voiced: number[];
};

export type QuestionReplay = {
  questionId: string;
  text: string;
  shownAtMs: number;
  endAtMs: number;
  series: SeriesSet;
  segments: { text: string; tMs: number }[];
};

/** サンプル再生モード(§9)と開発用エクスポートのファイル形式。
 *  §8 の Session(キャリブレーション用)とは別物で、時系列を含む。 */
export type ReplayFile = {
  kind: "replay-v1";
  session: Session;
  questionsReplay: QuestionReplay[];
  live: { t: number[]; a: number[]; e: number[] };
};

export type QuestionResult = {
  question: Question;
  analysis: Analysis;
  transcript: string;
  shownAtMs: number;
  endAtMs: number;
};

export type SessionResultData = {
  session: Session;
  aggregate: Analysis;
  perQuestion: QuestionResult[];
  score: ScoreResult;
  replay: ReplayFile;
};

// ---------------------------------------------------------------------------
// ライブ状態(§6.3 / §9)。ホットパスは React state を経由しない。
// UI は ref 経由でこのオブジェクトを直接読む。
// ---------------------------------------------------------------------------

export type LiveState = {
  /** EMA 済み軸値(0-100)。データ不足時 NaN */
  a: number;
  e: number;
  rms: number;
  f0: number; // 0 = 無声
  voiced: boolean;
  faceDetected: boolean;
  interim: string;
  /** 4象限トレイル */
  trailT: FloatRing;
  trailA: FloatRing;
  trailE: FloatRing;
};

export function createLiveState(): LiveState {
  const cap = LIVE.TRAIL_SEC * LIVE.TRAIL_HZ;
  return {
    a: NaN,
    e: NaN,
    rms: 0,
    f0: 0,
    voiced: false,
    faceDetected: false,
    interim: "",
    trailT: new FloatRing(cap),
    trailA: new FloatRing(cap),
    trailE: new FloatRing(cap),
  };
}

// ---------------------------------------------------------------------------
// SessionRecorder — 設問進行・フレーム蓄積・ライブ値・最終集計
// ---------------------------------------------------------------------------

const SERIES_HZ = 10;

export class SessionRecorder {
  readonly live: LiveState = createLiveState();

  private ring = new FrameRing(SIGNAL.RING_SECONDS * SIGNAL.FPS);
  private readonly completed: QuestionResult[] = [];
  private readonly replaySeries: QuestionReplay[] = [];

  private currentQuestion: Question | null = null;
  private currentShownAt = 0;
  private currentSegments: { text: string; tMs: number }[] = [];

  /** セッション累計の言語カウント(ライブ用) */
  private readonly lexTotal: LexCounts = emptyLexCounts();
  private completedSpeechSec = 0;
  private currentVoicedFrames = 0;

  /** 応答潜時のライブ検出 */
  private voicedRunStart: number | null = null;
  private currentLatencyMs: number | null = null;

  private emaA = new Ema(LIVE.EMA_ALPHA);
  private emaE = new Ema(LIVE.EMA_ALPHA);
  private lastLiveTick = 0;

  private readonly liveT: number[] = [];
  private readonly liveA: number[] = [];
  private readonly liveE: number[] = [];

  constructor(
    private readonly gate: GateInfo,
    private readonly speechEnabled: boolean,
    private readonly device: string,
  ) {}

  beginQuestion(q: Question, shownAtMs: number): void {
    this.currentQuestion = q;
    this.currentShownAt = shownAtMs;
    this.currentSegments = [];
    this.currentLatencyMs = null;
    this.voicedRunStart = null;
    this.currentVoicedFrames = 0;
    this.ring.clear();
  }

  get questionActive(): boolean {
    return this.currentQuestion !== null;
  }

  /** 新しい映像フレームを処理するたびに1回呼ぶ(≈30fps)。アロケーションなし。 */
  pushFrame(
    t: number,
    detected: boolean,
    blend: Float32Array | null,
    yaw: number,
    pitch: number,
    roll: number,
    rms: number,
    f0: number | null,
    voiced: boolean,
  ): void {
    if (!this.currentQuestion) return;
    this.ring.push(t, detected, blend, yaw, pitch, roll, rms, f0, voiced);
    if (voiced) this.currentVoicedFrames++;

    // 応答潜時(ライブ表示用)。確定値は endQuestion で生データから再計算する。
    if (this.currentLatencyMs === null) {
      if (voiced) {
        if (this.voicedRunStart === null) this.voicedRunStart = t;
        else if (t - this.voicedRunStart >= SIGNAL.RESPONSE_SUSTAIN_MS) {
          this.currentLatencyMs = Math.max(0, this.voicedRunStart - this.currentShownAt);
        }
      } else {
        this.voicedRunStart = null;
      }
    }

    this.live.rms = rms;
    this.live.f0 = f0 ?? 0;
    this.live.voiced = voiced;
    this.live.faceDetected = detected;
  }

  addFinalSegment(text: string, tMs: number): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.currentSegments.push({ text: trimmed, tMs: Math.round(tMs) });
    addLexCounts(this.lexTotal, analyzeSegment(trimmed));
  }

  setInterim(text: string): void {
    this.live.interim = text;
  }

  /** rAF ループから毎回呼んでよい。LIVE.UPDATE_MS 間隔で実際の再計算をする。 */
  liveTick(nowMs: number): void {
    if (nowMs - this.lastLiveTick < LIVE.UPDATE_MS) return;
    this.lastLiveTick = nowMs;
    if (!this.currentQuestion) return;

    const feats = this.computeLiveFeatures(nowMs);
    const lexHitRate =
      this.lexTotal.sentences > 0
        ? (this.lexTotal.hedges + this.lexTotal.assertions) / this.lexTotal.sentences
        : 0;
    // ライブでは文数が少ないうちの誤除外を避けるため、緩い条件で辞書を使う
    const lexiconReliable =
      this.lexTotal.sentences < 5 || lexHitRate >= SIGNAL.LEXICON_MIN_HIT_RATE;
    const { a, e } = liveAxes(feats, lexiconReliable);

    if (a !== null) this.live.a = this.emaA.push(a);
    if (e !== null) this.live.e = this.emaE.push(e);

    if (!Number.isNaN(this.live.a) && !Number.isNaN(this.live.e)) {
      this.live.trailT.push(nowMs);
      this.live.trailA.push(this.live.a);
      this.live.trailE.push(this.live.e);
      this.liveT.push(Math.round(nowMs));
      this.liveA.push(round1(this.live.a));
      this.liveE.push(round1(this.live.e));
    }
  }

  /** スライディング窓(LIVE.WINDOW_MS)のライブ特徴量。4Hz なので小さな確保は許容。 */
  private computeLiveFeatures(nowMs: number): FeatureValues {
    const sinceT = nowMs - LIVE.WINDOW_MS;
    const smileVals: number[] = [];
    const pitchVals: number[] = [];
    let frames = 0;
    let detected = 0;
    let voiced = 0;
    let smileOn = 0;
    let browOn = 0;
    let exprSum = 0;
    let exprSumSq = 0;
    let rmsVoicedSum = 0;
    let f0Sum = 0;
    let f0SumSq = 0;
    let f0Count = 0;
    let firstT = -1;
    let lastT = -1;
    const pauses: number[] = [];
    let lastVoicedT = -1;
    let unvoicedStart = -1;

    const blendData = this.ring.blendData;
    this.ring.forEachRecent(sinceT, (t, det, base, _yaw, pitch, _roll, rms, f0, isVoiced) => {
      frames++;
      if (firstT < 0) firstT = t;
      lastT = t;
      if (isVoiced) {
        voiced++;
        rmsVoicedSum += rms;
        if (!Number.isNaN(f0) && f0 > 0) {
          f0Sum += f0;
          f0SumSq += f0 * f0;
          f0Count++;
        }
        if (unvoicedStart >= 0 && lastVoicedT >= 0) {
          const dur = t - unvoicedStart;
          if (dur >= SIGNAL.PAUSE_MIN_MS) pauses.push(dur);
        }
        unvoicedStart = -1;
        lastVoicedT = t;
      } else if (unvoicedStart < 0) {
        unvoicedStart = t;
      }
      if (!det) return;
      detected++;
      const smile = (blendData[base + BS.smileL] + blendData[base + BS.smileR]) / 2;
      const cheek = (blendData[base + BS.cheekL] + blendData[base + BS.cheekR]) / 2;
      const browInner = blendData[base + BS.browInner];
      const browL = blendData[base + BS.browOuterL];
      const browR = blendData[base + BS.browOuterR];
      smileVals.push(smile);
      if (smile > SIGNAL.SMILE_ON) smileOn++;
      if (browInner > SIGNAL.BROW_ON || browL > SIGNAL.BROW_ON || browR > SIGNAL.BROW_ON) {
        browOn++;
      }
      const expr = smile * 2 + cheek * 2 + browInner + browL + browR;
      exprSum += expr;
      exprSumSq += expr * expr;
      pitchVals.push(pitch);
    });

    const windowSec = firstT >= 0 ? Math.max(0.5, (lastT - firstT) / 1000) : 0;
    const speechSecTotal = this.completedSpeechSec + this.currentVoicedFrames / SIGNAL.FPS;
    const lex = this.lexTotal;

    let smileIntensity: number | null = null;
    if (smileVals.length > 0) {
      smileVals.sort((x, y) => y - x);
      const k = Math.max(1, Math.round(smileVals.length * SIGNAL.SMILE_TOP_FRACTION));
      let s = 0;
      for (let i = 0; i < k; i++) s += smileVals[i];
      smileIntensity = s / k;
    }

    const fps = frames > 1 && windowSec > 0 ? frames / windowSec : SIGNAL.FPS;
    let nodRate: number | null = null;
    if (pitchVals.length > 8 && windowSec > 2) {
      const arr = Float32Array.from(pitchVals);
      const crossings = bandpassZeroCrossings(arr, arr.length, fps);
      nodRate = crossings / (windowSec / 60);
    }

    const exprStd =
      detected > 1
        ? Math.sqrt(Math.max(0, exprSumSq / detected - (exprSum / detected) ** 2))
        : null;
    const f0CV =
      f0Count >= 10 && f0Sum > 0
        ? Math.sqrt(Math.max(0, f0SumSq / f0Count - (f0Sum / f0Count) ** 2)) / (f0Sum / f0Count)
        : null;

    const langOk = this.speechEnabled && lex.chars >= SIGNAL.MIN_TRANSCRIPT_CHARS;

    return {
      charPerMin: langOk && speechSecTotal >= 3 ? (lex.chars / speechSecTotal) * 60 : null,
      rmsMean: voiced > 0 ? rmsVoicedSum / voiced : null,
      responseLatencyMs: this.currentLatencyMs,
      meanPauseMs:
        pauses.length > 0
          ? pauses.reduce((x, y) => x + y, 0) / pauses.length
          : voiced > 0
            ? SIGNAL.PAUSE_MIN_MS
            : null,
      assertionRate: langOk && lex.sentences > 0 ? lex.assertions / lex.sentences : null,
      hedgeRate: langOk && lex.sentences > 0 ? lex.hedges / lex.sentences : null,
      fillerRate: langOk && lex.chars > 0 ? (lex.fillers / lex.chars) * 100 : null,
      firstPersonRate: langOk && lex.sentences > 0 ? lex.firstPerson / lex.sentences : null,
      smileRate: detected > 0 ? smileOn / detected : null,
      smileIntensity,
      browActivity: detected > 0 ? browOn / detected : null,
      expressionVariance: exprStd,
      nodRate,
      f0CV,
      emotionWordRate: langOk && lex.chars > 0 ? (lex.emotionWords / lex.chars) * 100 : null,
      duchenneRatio: null,
      blinkRate: null,
      voicedRatio: frames > 0 ? voiced / frames : null,
      poseStability: null,
      meanF0: f0Count > 0 ? f0Sum / f0Count : null,
    };
  }

  endQuestion(endAtMs: number): void {
    if (!this.currentQuestion) return;
    const frames = this.ring.snapshot();
    const segments = this.currentSegments.map((s) => s.text);
    const analysis = analyzeQuestion(frames, segments, this.currentShownAt, this.speechEnabled);
    this.completedSpeechSec += analysis.flags.speechSec;

    this.completed.push({
      question: this.currentQuestion,
      analysis,
      transcript: segments.join(" "),
      shownAtMs: this.currentShownAt,
      endAtMs,
    });
    this.replaySeries.push(
      buildSeries(frames, this.currentQuestion, this.currentShownAt, endAtMs, this.currentSegments),
    );
    this.currentQuestion = null;
    this.live.interim = "";
  }

  finish(recordedAt?: string): SessionResultData {
    const aggregate = aggregateAnalyses(this.completed.map((c) => c.analysis), this.speechEnabled);
    const score = scoreSession(aggregate.features, aggregate.flags, {
      passed: this.gate.passed,
      skipped: this.gate.skipped,
    });
    const session = buildSession({
      gate: this.gate,
      device: this.device,
      perQuestion: this.completed,
      aggregate,
      score,
      recordedAt,
    });
    const replay: ReplayFile = {
      kind: "replay-v1",
      session,
      questionsReplay: this.replaySeries,
      live: { t: this.liveT, a: this.liveA, e: this.liveE },
    };
    return { session, aggregate, perQuestion: this.completed, score, replay };
  }
}

// ---------------------------------------------------------------------------
// 純粋ビルダー(Node のサンプル生成からも使う)
// ---------------------------------------------------------------------------

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function roundFeatures(features: FeatureValues): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(features)) {
    out[k] = v === null ? null : round4(v);
  }
  return out;
}

export function buildSession(input: {
  gate: GateInfo;
  device: string;
  perQuestion: QuestionResult[];
  aggregate: Analysis;
  score: ScoreResult;
  recordedAt?: string;
  sessionId?: string;
}): Session {
  const { score } = input;
  return {
    sessionId: input.sessionId ?? crypto.randomUUID(),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    appVersion: APP_VERSION,
    environment: {
      gatePassed: input.gate.passed,
      gateResults: input.gate.results,
      device: input.device,
      speechRecognitionUsed: input.gate.speechRecognitionUsed,
    },
    questions: input.perQuestion.map((q) => ({
      questionId: q.question.id,
      text: q.question.text,
      durationMs: Math.round(q.endAtMs - q.shownAtMs),
      transcript: q.transcript,
      features: roundFeatures(q.analysis.features),
    })),
    aggregate: {
      features: roundFeatures(input.aggregate.features),
      assertiveness: score.assertiveness.score === null ? null : round1(score.assertiveness.score),
      expressiveness:
        score.expressiveness.score === null ? null : round1(score.expressiveness.score),
      quadrant: score.quadrant ?? "indeterminate",
      confidence: score.confidence.label,
    },
    normsVersion: NORMS_VERSION,
    groundTruth: null,
  };
}

/** 設問1問ぶんのタイムライン系列(約10Hz)を作る。 */
export function buildSeries(
  frames: QuestionFrames,
  question: Question,
  shownAtMs: number,
  endAtMs: number,
  segments: { text: string; tMs: number }[],
): QuestionReplay {
  const series: SeriesSet = { t: [], rms: [], f0: [], smile: [], brow: [], pitch: [], voiced: [] };
  const stride = Math.max(1, Math.round(SIGNAL.FPS / SERIES_HZ));
  for (let i = 0; i < frames.count; i += stride) {
    const base = i * BLEND_COUNT;
    series.t.push(Math.round(frames.t[i]));
    series.rms.push(round4(frames.rms[i]));
    const f0 = frames.f0[i];
    series.f0.push(Number.isNaN(f0) ? 0 : Math.round(f0));
    series.smile.push(round4((frames.blend[base + BS.smileL] + frames.blend[base + BS.smileR]) / 2));
    series.brow.push(
      round4(
        Math.max(
          frames.blend[base + BS.browInner],
          frames.blend[base + BS.browOuterL],
          frames.blend[base + BS.browOuterR],
        ),
      ),
    );
    series.pitch.push(Math.round(frames.pitch[i] * 10) / 10);
    series.voiced.push(frames.voiced[i]);
  }
  return {
    questionId: question.id,
    text: question.text,
    shownAtMs: Math.round(shownAtMs),
    endAtMs: Math.round(endAtMs),
    series,
    segments,
  };
}

/** ブラウザでのJSONダウンロード。 */
export function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
