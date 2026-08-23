// FrameRecord列 + 文字起こし → 特徴量(§5)。
// DOM に依存しない純粋モジュール。テストとサンプル生成(Node)からも使う。

import {
  ASSERTIONS,
  ASSERTION_ENDINGS,
  EMOTION_WORDS,
  FILLERS,
  FIRST_PERSON,
  HEDGES,
  SHARED_HEDGE_FILLER,
} from "../config/lexicon";
import { SIGNAL, type FeatureKey } from "../config/scoring";
import { BLEND_COUNT, BS } from "./blendshapeNames";
import { bandpassZeroCrossings, mean, risingEdges } from "./dsp";
import type { QuestionFrames } from "./ringBuffer";

export type FeatureValues = Record<FeatureKey, number | null>;

// ---------------------------------------------------------------------------
// 5.5 言語シグナル — 辞書マッチ(付録A)
// ---------------------------------------------------------------------------

export type LexCounts = {
  sentences: number;
  chars: number; // 空白除去後の総文字数
  hedges: number;
  assertions: number;
  fillers: number;
  emotionWords: number;
  firstPerson: number;
};

export function emptyLexCounts(): LexCounts {
  return { sentences: 0, chars: 0, hedges: 0, assertions: 0, fillers: 0, emotionWords: 0, firstPerson: 0 };
}

export function addLexCounts(into: LexCounts, add: LexCounts): void {
  into.sentences += add.sentences;
  into.chars += add.chars;
  into.hedges += add.hedges;
  into.assertions += add.assertions;
  into.fillers += add.fillers;
  into.emotionWords += add.emotionWords;
  into.firstPerson += add.firstPerson;
}

const byLengthDesc = (a: string, b: string) => b.length - a.length;
const alt = (words: string[]) => words.slice().sort(byLengthDesc).join("|");

const HEDGE_RE = new RegExp(alt(HEDGES), "g");
const ASSERT_RE = new RegExp(alt(ASSERTIONS), "g");
const FILLER_RE = new RegExp(alt(FILLERS), "g");
const EMOTION_RE = new RegExp(alt(EMOTION_WORDS), "g");
const FIRST_RE = new RegExp(alt(FIRST_PERSON), "g");
const SHARED_RE = new RegExp(alt(SHARED_HEDGE_FILLER), "g");
const ENDING_RE = new RegExp(`(?:${alt(ASSERTION_ENDINGS)})$`);

/** 文境界。「。？！」または確定区切り(セグメント終端)。 */
function splitSentences(segment: string): string[] {
  return segment
    .split(/[。！？!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const BOUNDARY_CHARS = new Set(["、", ",", "，", "。", "！", "？", "!", "?", " ", "　", "・", "…"]);

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** マッチのいずれかが end 位置ちょうどで終わるか */
function anyMatchEndsAt(re: RegExp, text: string, end: number): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index + m[0].length === end) return true;
  }
  return false;
}

/**
 * 1文を解析する。付録Aの実装上の注意:
 * - 「ちょっと」「まあ」「なんか」はフィラー判定を先に行う。
 *   前後とも境界(読点・文頭末)なら独立挿入 = フィラー、
 *   前が境界で直後に内容が続くなら修飾 = ヘッジ、
 *   それ以外(判定困難)はフィラー側に倒す。
 * - 断定の「です/ます/でした/ました」は文末言い切りのみ。文末にヘッジや
 *   断定表現そのものが掛かっている場合は重複カウントしない。
 */
export function analyzeSentence(sentence: string): Omit<LexCounts, "sentences" | "chars"> {
  const out = { hedges: 0, assertions: 0, fillers: 0, emotionWords: 0, firstPerson: 0 };
  const s = sentence;

  // 共有語(ちょっと/まあ/なんか)の振り分け
  SHARED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHARED_RE.exec(s)) !== null) {
    const prev = m.index === 0 ? "" : s[m.index - 1];
    const nextIdx = m.index + m[0].length;
    const next = nextIdx >= s.length ? "" : s[nextIdx];
    const prevB = prev === "" || BOUNDARY_CHARS.has(prev);
    const nextB = next === "" || BOUNDARY_CHARS.has(next);
    if (prevB && nextB) out.fillers++;
    else if (prevB && !nextB) out.hedges++;
    else out.fillers++; // 判定困難 → フィラー側(保守的)
  }

  out.fillers += countMatches(FILLER_RE, s);
  out.hedges += countMatches(HEDGE_RE, s);
  out.assertions += countMatches(ASSERT_RE, s);
  out.emotionWords += countMatches(EMOTION_RE, s);
  out.firstPerson += countMatches(FIRST_RE, s);

  // 文末言い切り判定(末尾の読点・空白は無視する)
  const core = s.replace(/[、,，\s　]+$/, "");
  if (core.length > 0 && ENDING_RE.test(core)) {
    const coveredByHedge = anyMatchEndsAt(HEDGE_RE, core, core.length);
    const coveredByAssert = anyMatchEndsAt(ASSERT_RE, core, core.length);
    if (!coveredByHedge && !coveredByAssert) out.assertions++;
  }
  return out;
}

/** 確定セグメント1件を解析する。 */
export function analyzeSegment(segment: string): LexCounts {
  const counts = emptyLexCounts();
  counts.chars = segment.replace(/[\s　]+/g, "").length;
  for (const sentence of splitSentences(segment)) {
    counts.sentences++;
    const s = analyzeSentence(sentence);
    counts.hedges += s.hedges;
    counts.assertions += s.assertions;
    counts.fillers += s.fillers;
    counts.emotionWords += s.emotionWords;
    counts.firstPerson += s.firstPerson;
  }
  return counts;
}

export function analyzeTranscript(segments: string[]): LexCounts {
  const total = emptyLexCounts();
  for (const seg of segments) addLexCounts(total, analyzeSegment(seg));
  return total;
}

// ---------------------------------------------------------------------------
// フレーム集計
// ---------------------------------------------------------------------------

/** 集計アキュムレータ。設問単位で作り、セッション集計はこれをマージして再計算する。
 *  「確定値はライブ値の中央値ではなく生の特徴量から再計算する」(§6.3)ための構造。 */
export type FeatureAcc = {
  frameCount: number;
  detectedCount: number;
  voicedCount: number;
  spanMs: number;
  detectedSpanMs: number;
  speechSec: number;
  pauses: number[];
  nodCrossings: number;
  blinkEdges: number;
  smileVals: number[];
  smileOnFrames: number;
  duchenneFrames: number;
  browOnFrames: number;
  exprSum: number; exprSumSq: number; exprCount: number;
  f0Sum: number; f0SumSq: number; f0Count: number;
  yawSum: number; yawSumSq: number;
  rollSum: number; rollSumSq: number;
  poseCount: number;
  rmsVoicedSum: number;
  latencies: number[];
  lex: LexCounts;
};

export function emptyAcc(): FeatureAcc {
  return {
    frameCount: 0, detectedCount: 0, voicedCount: 0,
    spanMs: 0, detectedSpanMs: 0, speechSec: 0,
    pauses: [], nodCrossings: 0, blinkEdges: 0,
    smileVals: [], smileOnFrames: 0, duchenneFrames: 0, browOnFrames: 0,
    exprSum: 0, exprSumSq: 0, exprCount: 0,
    f0Sum: 0, f0SumSq: 0, f0Count: 0,
    yawSum: 0, yawSumSq: 0, rollSum: 0, rollSumSq: 0, poseCount: 0,
    rmsVoicedSum: 0,
    latencies: [],
    lex: emptyLexCounts(),
  };
}

export function mergeAcc(into: FeatureAcc, add: FeatureAcc): void {
  into.frameCount += add.frameCount;
  into.detectedCount += add.detectedCount;
  into.voicedCount += add.voicedCount;
  into.spanMs += add.spanMs;
  into.detectedSpanMs += add.detectedSpanMs;
  into.speechSec += add.speechSec;
  into.pauses.push(...add.pauses);
  into.nodCrossings += add.nodCrossings;
  into.blinkEdges += add.blinkEdges;
  into.smileVals.push(...add.smileVals);
  into.smileOnFrames += add.smileOnFrames;
  into.duchenneFrames += add.duchenneFrames;
  into.browOnFrames += add.browOnFrames;
  into.exprSum += add.exprSum; into.exprSumSq += add.exprSumSq; into.exprCount += add.exprCount;
  into.f0Sum += add.f0Sum; into.f0SumSq += add.f0SumSq; into.f0Count += add.f0Count;
  into.yawSum += add.yawSum; into.yawSumSq += add.yawSumSq;
  into.rollSum += add.rollSum; into.rollSumSq += add.rollSumSq;
  into.poseCount += add.poseCount;
  into.rmsVoicedSum += add.rmsVoicedSum;
  into.latencies.push(...add.latencies);
  addLexCounts(into.lex, add.lex);
}

const B = SIGNAL;

/** 設問1問ぶんのフレーム列からアキュムレータを作る。 */
export function accumulateFrames(
  frames: QuestionFrames,
  shownAtMs: number,
): FeatureAcc {
  const acc = emptyAcc();
  const n = frames.count;
  acc.frameCount = n;
  if (n < 2) return acc;

  const spanMs = frames.t[n - 1] - frames.t[0];
  const avgDtMs = spanMs / (n - 1);
  acc.spanMs = spanMs;

  // 頭部姿勢・まばたき用の系列(検出フレームのみ)
  const pitchSeries = new Float32Array(n);
  const blinkSeries = new Float32Array(n);
  let detIdx = 0;

  let firstVoiced = -1;
  let lastVoiced = -1;

  for (let i = 0; i < n; i++) {
    const detected = frames.detected[i] === 1;
    const voiced = frames.voiced[i] === 1;
    if (voiced) {
      acc.voicedCount++;
      acc.rmsVoicedSum += frames.rms[i];
      if (firstVoiced < 0) firstVoiced = i;
      lastVoiced = i;
      const f0 = frames.f0[i];
      if (!Number.isNaN(f0) && f0 > 0) {
        acc.f0Sum += f0;
        acc.f0SumSq += f0 * f0;
        acc.f0Count++;
      }
    }
    if (!detected) continue;

    acc.detectedCount++;
    const base = i * BLEND_COUNT;
    const smile = (frames.blend[base + BS.smileL] + frames.blend[base + BS.smileR]) / 2;
    const cheek = (frames.blend[base + BS.cheekL] + frames.blend[base + BS.cheekR]) / 2;
    const browInner = frames.blend[base + BS.browInner];
    const browL = frames.blend[base + BS.browOuterL];
    const browR = frames.blend[base + BS.browOuterR];
    const blink = (frames.blend[base + BS.blinkL] + frames.blend[base + BS.blinkR]) / 2;

    acc.smileVals.push(smile);
    if (smile > B.SMILE_ON) {
      acc.smileOnFrames++;
      if (cheek > B.CHEEK_ON) acc.duchenneFrames++;
    }
    if (browInner > B.BROW_ON || browL > B.BROW_ON || browR > B.BROW_ON) acc.browOnFrames++;

    const expr = smile * 2 + cheek * 2 + browInner + browL + browR;
    acc.exprSum += expr;
    acc.exprSumSq += expr * expr;
    acc.exprCount++;

    acc.yawSum += frames.yaw[i];
    acc.yawSumSq += frames.yaw[i] * frames.yaw[i];
    acc.rollSum += frames.roll[i];
    acc.rollSumSq += frames.roll[i] * frames.roll[i];
    acc.poseCount++;

    pitchSeries[detIdx] = frames.pitch[i];
    blinkSeries[detIdx] = blink;
    detIdx++;
  }

  acc.detectedSpanMs = acc.detectedCount * avgDtMs;
  acc.speechSec = (acc.voicedCount * avgDtMs) / 1000;

  const fps = avgDtMs > 0 ? 1000 / avgDtMs : B.FPS;
  acc.nodCrossings = bandpassZeroCrossings(pitchSeries, detIdx, fps);
  acc.blinkEdges = risingEdges(blinkSeries, detIdx, B.BLINK_ON);

  // ポーズ(発話区間内部の ≥PAUSE_MIN_MS の無声区間)
  if (firstVoiced >= 0 && lastVoiced > firstVoiced) {
    let runStart = -1;
    for (let i = firstVoiced; i <= lastVoiced; i++) {
      if (frames.voiced[i] === 0) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        const dur = frames.t[i] - frames.t[runStart];
        if (dur >= B.PAUSE_MIN_MS) acc.pauses.push(dur);
        runStart = -1;
      }
    }
  }

  // 応答潜時: 設問表示 → VAD が RESPONSE_SUSTAIN_MS 継続した立ち上がり(§5.4)
  let i = 0;
  while (i < n) {
    if (frames.voiced[i] === 1 && frames.t[i] >= shownAtMs) {
      let j = i;
      while (j + 1 < n && frames.voiced[j + 1] === 1) j++;
      if (frames.t[j] - frames.t[i] >= B.RESPONSE_SUSTAIN_MS) {
        acc.latencies.push(Math.max(0, frames.t[i] - shownAtMs));
        break;
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  return acc;
}

function stdFromSums(sum: number, sumSq: number, count: number): number {
  if (count < 2) return 0;
  const m = sum / count;
  const v = Math.max(0, sumSq / count - m * m);
  return Math.sqrt(v);
}

export type AnalysisFlags = {
  /** 音声認識が有効で、判定に足る文字数が取れているか(§6.2) */
  languageAvailable: boolean;
  /** 辞書ヒット数が異常に少なくないか(付録A: 誤変換対策) */
  lexiconReliable: boolean;
  faceDetectRate: number;
  speechSec: number;
  sentenceCount: number;
};

export type Analysis = {
  features: FeatureValues;
  acc: FeatureAcc;
  flags: AnalysisFlags;
};

/** アキュムレータ → 特徴量。取れない特徴量は null(重み再正規化の対象)。 */
export function featuresFromAcc(acc: FeatureAcc, speechEnabled: boolean): Analysis {
  const det = acc.detectedCount;
  const lex = acc.lex;
  const languageAvailable = speechEnabled && lex.chars >= B.MIN_TRANSCRIPT_CHARS;
  const lexHitRate = lex.sentences > 0 ? (lex.hedges + lex.assertions) / lex.sentences : 0;
  const lexiconReliable = languageAvailable && lexHitRate >= B.LEXICON_MIN_HIT_RATE;

  const minutesDetected = acc.detectedSpanMs / 60_000;
  const hasSpeech = acc.voicedCount > 0;

  // smileIntensity: 上位10%フレームの平均(§5.2)
  let smileIntensity: number | null = null;
  if (acc.smileVals.length > 0) {
    const sorted = acc.smileVals.slice().sort((a, b) => b - a);
    const k = Math.max(1, Math.round(sorted.length * B.SMILE_TOP_FRACTION));
    smileIntensity = mean(sorted, k);
  }

  const features: FeatureValues = {
    // 主張性
    charPerMin:
      languageAvailable && acc.speechSec >= 3 ? (lex.chars / acc.speechSec) * 60 : null,
    rmsMean: hasSpeech ? acc.rmsVoicedSum / acc.voicedCount : null,
    responseLatencyMs: acc.latencies.length > 0 ? mean(acc.latencies) : null,
    meanPauseMs:
      acc.pauses.length > 0 ? mean(acc.pauses) : hasSpeech ? B.PAUSE_MIN_MS : null,
    assertionRate: languageAvailable && lex.sentences > 0 ? lex.assertions / lex.sentences : null,
    hedgeRate: languageAvailable && lex.sentences > 0 ? lex.hedges / lex.sentences : null,
    fillerRate: languageAvailable && lex.chars > 0 ? (lex.fillers / lex.chars) * 100 : null,
    firstPersonRate:
      languageAvailable && lex.sentences > 0 ? lex.firstPerson / lex.sentences : null,
    // 感情表出性
    smileRate: det > 0 ? acc.smileOnFrames / det : null,
    smileIntensity,
    browActivity: det > 0 ? acc.browOnFrames / det : null,
    expressionVariance: acc.exprCount > 1 ? stdFromSums(acc.exprSum, acc.exprSumSq, acc.exprCount) : null,
    nodRate: det > 0 && minutesDetected > 0 ? acc.nodCrossings / minutesDetected : null,
    f0CV:
      acc.f0Count >= B.F0_MIN_SAMPLES && acc.f0Sum > 0
        ? stdFromSums(acc.f0Sum, acc.f0SumSq, acc.f0Count) / (acc.f0Sum / acc.f0Count)
        : null,
    emotionWordRate:
      languageAvailable && lex.chars > 0 ? (lex.emotionWords / lex.chars) * 100 : null,
    // 参考値
    duchenneRatio: acc.smileOnFrames > 0 ? acc.duchenneFrames / acc.smileOnFrames : null,
    blinkRate: det > 0 && minutesDetected > 0 ? acc.blinkEdges / minutesDetected : null,
    voicedRatio: acc.frameCount > 0 ? acc.voicedCount / acc.frameCount : null,
    poseStability:
      acc.poseCount > 1
        ? (stdFromSums(acc.yawSum, acc.yawSumSq, acc.poseCount) +
            stdFromSums(acc.rollSum, acc.rollSumSq, acc.poseCount)) / 2
        : null,
    meanF0: acc.f0Count >= B.F0_MIN_SAMPLES ? acc.f0Sum / acc.f0Count : null,
  };

  return {
    features,
    acc,
    flags: {
      languageAvailable,
      lexiconReliable,
      faceDetectRate: acc.frameCount > 0 ? det / acc.frameCount : 0,
      speechSec: acc.speechSec,
      sentenceCount: lex.sentences,
    },
  };
}

/** 設問1問ぶんの解析。 */
export function analyzeQuestion(
  frames: QuestionFrames,
  segments: string[],
  shownAtMs: number,
  speechEnabled: boolean,
): Analysis {
  const acc = accumulateFrames(frames, shownAtMs);
  acc.lex = analyzeTranscript(segments);
  return featuresFromAcc(acc, speechEnabled);
}

/** セッション集計。設問境界をまたぐポーズや潜時を混ぜないため、
 *  設問単位のアキュムレータをマージして生値から再計算する(§6.3)。 */
export function aggregateAnalyses(list: Analysis[], speechEnabled: boolean): Analysis {
  const acc = emptyAcc();
  for (const a of list) mergeAcc(acc, a.acc);
  return featuresFromAcc(acc, speechEnabled);
}
