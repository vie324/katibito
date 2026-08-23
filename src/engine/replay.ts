// サンプルセッション再生モード(§9 落ちない設計)。
// カメラ・モデル・マイクが一切なくても、記録済みシグナルでライブ画面と結果画面を通す。

import { ASSET_PATHS } from "../config/flags";
import type { FeatureKey } from "../config/scoring";
import type { FeatureValues } from "./features";
import { scoreSession, type ScoreResult } from "./scoring";
import type { LiveState, QuestionReplay, ReplayFile, Session } from "./sessionStore";

export async function loadSampleSession(): Promise<ReplayFile> {
  const res = await fetch(ASSET_PATHS.SAMPLE_SESSION);
  if (!res.ok) throw new Error(`サンプルセッションを読み込めません (HTTP ${res.status})`);
  const data = (await res.json()) as ReplayFile;
  if (data.kind !== "replay-v1") throw new Error("サンプルセッションの形式が不正です");
  return data;
}

/** 保存済み Session から結果画面用のスコア(寄与内訳つき)を再構成する。
 *  確定ラベル(象限・確信度)は保存値を優先する。 */
export function scoreFromSession(session: Session): ScoreResult {
  const features = session.aggregate.features as Record<FeatureKey, number | null> as FeatureValues;
  const languageAvailable = features.charPerMin !== null || features.assertionRate !== null;
  const score = scoreSession(
    features,
    {
      languageAvailable,
      lexiconReliable: features.assertionRate !== null,
      // 生フレームは保存しない(§8)ので、確信度の内訳はラベルのみ復元する
      faceDetectRate: 1,
      speechSec: 999,
    },
    { passed: session.environment.gatePassed, skipped: false },
  );
  score.confidence.label = session.aggregate.confidence;
  return score;
}

export type ReplayCallbacks = {
  onQuestion: (index: number, q: QuestionReplay) => void;
  onFinished: () => void;
};

/**
 * ReplayFile の時系列を実時間で再生し、LiveState(メーター・トレイル・波形代替)を駆動する。
 * tick() は rAF から毎フレーム呼ぶ。
 */
export class ReplayPlayer {
  private startedAt = 0;
  private playhead = 0; // セッションクロック ms
  private speed = 1;
  private questionIndex = -1;
  private finished = false;

  // 系列カーソル(単調前進)
  private seriesCursor = 0;
  private liveCursor = 0;
  private segmentCursor = 0;

  constructor(
    private readonly file: ReplayFile,
    private readonly live: LiveState,
    private readonly callbacks: ReplayCallbacks,
  ) {}

  get durationMs(): number {
    const qs = this.file.questionsReplay;
    return qs.length > 0 ? qs[qs.length - 1].endAtMs : 0;
  }

  get currentTimeMs(): number {
    return this.playhead;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  setSpeed(x: number): void {
    // 現在位置を保ったまま速度を変える
    this.startedAt = performance.now() - this.playhead / x;
    this.speed = x;
  }

  start(): void {
    this.startedAt = performance.now();
    this.playhead = 0;
    this.enterQuestion(0);
  }

  private enterQuestion(index: number): void {
    this.questionIndex = index;
    this.seriesCursor = 0;
    this.segmentCursor = 0;
    const q = this.file.questionsReplay[index];
    this.callbacks.onQuestion(index, q);
  }

  tick(): void {
    if (this.finished) return;
    this.playhead = (performance.now() - this.startedAt) * this.speed;
    const qs = this.file.questionsReplay;
    if (this.questionIndex < 0 || this.questionIndex >= qs.length) return;

    let q = qs[this.questionIndex];
    while (this.playhead > q.endAtMs) {
      if (this.questionIndex + 1 >= qs.length) {
        this.finished = true;
        this.callbacks.onFinished();
        return;
      }
      this.enterQuestion(this.questionIndex + 1);
      q = qs[this.questionIndex];
    }

    // シグナル系列(10Hz)を現在位置まで進める
    const s = q.series;
    while (this.seriesCursor + 1 < s.t.length && s.t[this.seriesCursor + 1] <= this.playhead) {
      this.seriesCursor++;
    }
    const i = this.seriesCursor;
    if (i < s.t.length) {
      this.live.rms = s.rms[i];
      this.live.f0 = s.f0[i];
      this.live.voiced = s.voiced[i] === 1;
      this.live.faceDetected = true;
    }

    // ライブ軸値
    const lv = this.file.live;
    while (this.liveCursor + 1 < lv.t.length && lv.t[this.liveCursor + 1] <= this.playhead) {
      this.liveCursor++;
    }
    if (this.liveCursor < lv.t.length && lv.t[this.liveCursor] <= this.playhead) {
      const a = lv.a[this.liveCursor];
      const e = lv.e[this.liveCursor];
      if (a !== this.live.a || e !== this.live.e) {
        this.live.a = a;
        this.live.e = e;
        this.live.trailT.push(this.playhead);
        this.live.trailA.push(a);
        this.live.trailE.push(e);
      }
    }

    // 文字起こしセグメント(確定済みテキストの再生)
    while (
      this.segmentCursor < q.segments.length &&
      q.segments[this.segmentCursor].tMs <= this.playhead
    ) {
      this.live.interim = q.segments[this.segmentCursor].text;
      this.segmentCursor++;
    }
  }
}
