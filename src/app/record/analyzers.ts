// 表情の計測: 録画中(カメラ映像)と、動画ファイル/サーバーの録画からの2経路。
// どちらも「映っている顔をすべて検出 → 候補者の顔だけ選ぶ → 顔トラックに積む」。
// ホットパスは React state を通さない。画面は status を数Hzで読みにいく。

import { CandidateTracker, type Box, type TargetState } from "../../analysis/candidate";
import { defaultTrackMeta, FaceTrackBuilder, type FaceTrack } from "../../analysis/faceTrack";
import { APP_VERSION } from "../../config/flags";
import { INTERVIEW_ANALYSIS } from "../../config/scoring";
import type { AudioEngine } from "../../engine/audioEngine";
import type { FaceEngine, FaceObservation } from "../../engine/faceEngine";

export type AnalyzerStatus = {
  /** 直近フレームの顔の位置(すべて) */
  boxes: Box[];
  /** boxes のうち候補者の位置。見つからなければ -1 */
  candidate: number;
  /** 候補者の顔が最後に見えた時刻(performance.now) */
  lastSeenAt: number;
  /** 実効の解析レート */
  fps: number;
  frames: number;
};

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

function onFrames(video: VideoWithRvfc, cb: (now: number, mediaTime: number) => void): () => void {
  let stopped = false;
  let handle = 0;
  if (video.requestVideoFrameCallback) {
    const tick = (now: number, meta: { mediaTime: number }) => {
      if (stopped) return;
      cb(now, meta.mediaTime);
      handle = video.requestVideoFrameCallback!(tick);
    };
    handle = video.requestVideoFrameCallback(tick);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback?.(handle);
    };
  }
  const tick = (now: number) => {
    if (stopped) return;
    cb(now, video.currentTime);
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(handle);
  };
}

type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };

/**
 * 映像のトラックから直接フレームを受け取る(Chrome の MediaStreamTrackProcessor)。
 * 画面の描画とは関係なく届くため、この画面が裏に回っている間(Meet のタブを見ている間など)も計測が続く。
 * 使えないブラウザでは null(video 要素の描画に合わせて計測する)。
 */
function onTrackFrames(track: MediaStreamTrack, cb: (now: number, frame: VideoFrame) => void): (() => void) | null {
  const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  if (!Ctor || track.readyState !== "live") return null;
  const clone = track.clone();
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    // 計測が追いつかないときは古いフレームを捨て、いちばん新しいフレームを使う
    reader = new Ctor({ track: clone, maxBufferSize: 1 }).readable.getReader();
  } catch {
    clone.stop();
    return null;
  }
  let stopped = false;
  let finished = false;
  let cloneStopped = false;
  const stopClone = () => {
    if (cloneStopped) return;
    cloneStopped = true;
    clone.stop();
  };
  void (async () => {
    // 届いたフレームはすべて閉じる(閉じずに捨てたフレームは、閉じられないまま残るため)。
    // 止めるときは、フレームを読んで閉じた直後か、次のフレームを待っている間に複製したトラックを止める
    // (読み取りの列にフレームが残ったまま止めると、そのフレームが閉じられずに捨てられる)
    for (;;) {
      let r: ReadableStreamReadResult<VideoFrame>;
      try {
        r = await reader.read();
      } catch {
        break;
      }
      if (r.done) break;
      const frame = r.value;
      if (stopped) {
        frame.close();
        stopClone();
        continue;
      }
      try {
        cb(performance.now(), frame);
      } finally {
        frame.close();
      }
    }
    finished = true;
  })();
  return () => {
    stopped = true;
    // 映像が止まっていて次のフレームが来ないときのため。タイマーは読み取りを待っている間にしか動かない
    setTimeout(stopClone, 300);
    setTimeout(() => {
      if (!finished) void reader.cancel().catch(() => undefined);
    }, 3000);
  };
}

function toSample(f: FaceObservation) {
  return { blend: f.blend, yaw: f.yaw, pitch: f.pitch, roll: f.roll, box: f.box };
}

// ---------------------------------------------------------------------------
// 録画中(カメラ)
// ---------------------------------------------------------------------------

export class LiveAnalyzer {
  readonly status: AnalyzerStatus = { boxes: [], candidate: -1, lastSeenAt: 0, fps: 0, frames: 0 };
  readonly tracker = new CandidateTracker();
  private builder: FaceTrackBuilder | null = null;
  private t0: number | null = null;
  private stopLoop: (() => void) | null = null;
  private lastAt = -Infinity;
  private hiddenSince: number | null = null;
  private rateWindow: number[] = [];
  private frameW = 0;
  private frameH = 0;
  private viaTrack = false;
  private trackErrors = 0;
  private readonly onVisibility = () => this.handleVisibility();

  /** track を渡すと、映像のトラックから直接フレームを受け取る(使えなければ video 要素から) */
  constructor(
    private readonly engine: FaceEngine,
    private readonly video: HTMLVideoElement,
    private readonly audio: AudioEngine | null,
    private readonly track: MediaStreamTrack | null = null,
  ) {
    this.tracker.setAspect((video.videoWidth || 16) / (video.videoHeight || 9));
  }

  /** この画面が裏に回ると計測が止まるか(映像のトラックから直接受け取れないとき) */
  get pausesWhenHidden(): boolean {
    return !this.viaTrack;
  }

  /** プレビュー(撮影準備)から動かす。recording を始めるまで顔トラックには積まない */
  run(): void {
    if (this.stopLoop) return;
    const stop = this.track ? onTrackFrames(this.track, (now, f) => this.frame(now, f)) : null;
    if (stop) {
      this.viaTrack = true;
      this.stopLoop = stop;
      return;
    }
    this.runOnVideo();
  }

  private runOnVideo(): void {
    this.viaTrack = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    // 裏に回っている間に切り替えた場合: 表に戻るまでは計測できないので、いまから「非表示」の区間とする
    if (document.visibilityState === "hidden" && this.hiddenSince === null) this.hiddenSince = performance.now();
    this.stopLoop = onFrames(this.video, (now) => this.frame(now, null));
  }

  setTarget(t: TargetState | null): void {
    if (t) this.tracker.setTarget(t.cx, t.cy, t.h);
    else this.tracker.reset();
  }

  /**
   * 録画開始。t0 は MediaRecorder の start 時刻。
   * late = 計測の準備より先に録画が始まっていた(録画の先頭からいままでは計測していない区間として残す)
   */
  beginRecording(t0: number, late = false): void {
    this.t0 = t0;
    const cur = this.tracker.current;
    this.builder = new FaceTrackBuilder(
      defaultTrackMeta({
        source: "live",
        intervalMs: INTERVIEW_ANALYSIS.LIVE_INTERVAL_MS,
        videoWidth: this.frameW || this.video.videoWidth,
        videoHeight: this.frameH || this.video.videoHeight,
        appVersion: APP_VERSION,
        hasAudio: this.audio !== null,
        target: cur ? { cx: cur.cx, cy: cur.cy } : null,
      }),
      30 * 60 * 16,
    );
    if (late) {
      const endMs = Math.max(0, performance.now() - t0);
      if (endMs > 0) this.builder.addGap({ startMs: 0, endMs, reason: "stalled" });
    }
  }

  /** 録画中の顔トラック(途中保存用のコピー) */
  snapshot(): FaceTrack | null {
    return this.builder ? this.builder.build() : null;
  }

  stop(): FaceTrack | null {
    this.stopLoop?.();
    this.stopLoop = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.hiddenSince !== null && this.builder && this.t0 !== null) {
      this.builder.addGap({ startMs: this.hiddenSince - this.t0, endMs: performance.now() - this.t0, reason: "hidden" });
      this.hiddenSince = null;
    }
    const track = this.builder ? this.builder.build() : null;
    return track;
  }

  private handleVisibility(): void {
    if (document.visibilityState === "hidden") {
      if (this.hiddenSince === null) this.hiddenSince = performance.now();
    } else if (this.hiddenSince !== null) {
      if (this.builder && this.t0 !== null) {
        this.builder.addGap({
          startMs: Math.max(0, this.hiddenSince - this.t0),
          endMs: Math.max(0, performance.now() - this.t0),
          reason: "hidden",
        });
      }
      this.hiddenSince = null;
    }
  }

  private frame(now: number, vf: VideoFrame | null): void {
    if (now - this.lastAt < INTERVIEW_ANALYSIS.LIVE_INTERVAL_MS - 4) return;
    let source: TexImageSource;
    let w: number;
    let h: number;
    if (vf) {
      source = vf;
      w = vf.displayWidth;
      h = vf.displayHeight;
    } else {
      if (this.video.readyState < 2 || this.video.videoWidth === 0) return;
      source = this.video;
      w = this.video.videoWidth;
      h = this.video.videoHeight;
    }
    if (w === 0 || h === 0) return;
    // 画面の共有では、共有したタブの大きさが変わると映像の縦横比も変わる
    if (w !== this.frameW || h !== this.frameH) {
      this.frameW = w;
      this.frameH = h;
      this.tracker.setAspect(w / h);
    }
    this.lastAt = now;
    let faces: FaceObservation[];
    try {
      faces = this.engine.detectAll(source, now);
      this.trackErrors = 0;
    } catch (e) {
      console.warn("[analyzer] 検出に失敗", e);
      // トラックのフレームを受け付けない環境: video 要素からの計測に切り替える
      if (vf && ++this.trackErrors >= 5) {
        this.stopLoop?.();
        this.runOnVideo();
      }
      return;
    }
    const boxes = faces.map((f) => f.box);
    const idx = this.tracker.pick(boxes, now);
    const s = this.status;
    s.boxes = boxes;
    s.candidate = idx;
    if (idx >= 0) s.lastSeenAt = now;
    s.frames++;
    this.rateWindow.push(now);
    while (this.rateWindow.length > 0 && now - this.rateWindow[0] > 2000) this.rateWindow.shift();
    s.fps = this.rateWindow.length / 2;

    const at = this.audio?.tick(now);
    if (this.builder && this.t0 !== null && now >= this.t0) {
      this.builder.push(now - this.t0, faces.length, idx >= 0 ? toSample(faces[idx]) : null, at?.rms ?? null, at?.voiced ?? false);
    }
  }
}

// ---------------------------------------------------------------------------
// 動画ファイル・サーバーの録画から
// ---------------------------------------------------------------------------

export type FileAnalysisProgress = {
  /** 0〜1(長さが分からない間は null) */
  fraction: number | null;
  mediaTimeMs: number;
  durationMs: number | null;
  playbackRate: number;
  /** 解析できた顔の割合(ここまで) */
  detectRate: number;
};

/**
 * 再生しながら解析する(シークを繰り返すより速い)。解析が追いつかなければ再生速度を落とす。
 * タブが非表示になると再生を止め、戻ったら続きから解析する。
 */
export function analyzeVideo(opts: {
  engine: FaceEngine;
  video: HTMLVideoElement;
  target: TargetState | null;
  onProgress: (p: FileAnalysisProgress) => void;
  signal?: AbortSignal;
  intervalMs?: number;
}): Promise<FaceTrack> {
  const { engine, video, signal } = opts;
  const intervalMs = opts.intervalMs ?? INTERVIEW_ANALYSIS.FILE_INTERVAL_MS;
  const tracker = new CandidateTracker();
  tracker.setAspect((video.videoWidth || 16) / (video.videoHeight || 9));
  if (opts.target) tracker.setTarget(opts.target.cx, opts.target.cy, opts.target.h);

  const builder = new FaceTrackBuilder(
    defaultTrackMeta({
      source: "file",
      intervalMs,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      appVersion: APP_VERSION,
      hasAudio: false,
      target: opts.target ? { cx: opts.target.cx, cy: opts.target.cy } : null,
    }),
  );

  return new Promise<FaceTrack>((resolve, reject) => {
    let lastMedia = -Infinity;
    // 控えめに始めて、解析が追いついていれば上げる
    let rate = 2;
    let analyzed = 0;
    let detected = 0;
    let windowStartWall = performance.now();
    let windowStartMedia = 0;
    let windowFrames = 0;
    let finished = false;
    let lastProgressAt = 0;

    const durationMs = () => (Number.isFinite(video.duration) ? video.duration * 1000 : null);

    const cleanup = () => {
      stopFrames();
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      signal?.removeEventListener("abort", onAbort);
      video.pause();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(builder.build());
    };
    const onEnded = () => finish();
    const onError = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error("動画を再生できません。形式を確認してください(Chrome で再生できる MP4 / WebM)"));
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new DOMException("中止しました", "AbortError"));
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        video.pause();
      } else if (!finished) {
        // 非表示の間に進んだぶんを取りこぼさないよう、最後に解析した位置へ戻す
        if (Number.isFinite(lastMedia)) video.currentTime = Math.max(0, lastMedia / 1000);
        void video.play().catch(() => undefined);
      }
    };

    const stopFrames = onFrames(video as VideoWithRvfc, (now, mediaTime) => {
      const mediaMs = mediaTime * 1000;
      if (mediaMs - lastMedia < intervalMs) return;
      lastMedia = mediaMs;
      let faces: FaceObservation[] = [];
      try {
        faces = engine.detectAll(video, now);
      } catch (e) {
        console.warn("[analyzer] 検出に失敗", e);
      }
      const idx = tracker.pick(
        faces.map((f) => f.box),
        mediaMs,
      );
      builder.push(mediaMs, faces.length, idx >= 0 ? toSample(faces[idx]) : null);
      analyzed++;
      if (idx >= 0) detected++;
      windowFrames++;

      // 解析の密度(動画1秒あたりのフレーム数)を見て再生速度を調整する。
      // 足りなければ不足ぶんに比例して下げ(遅い端末では等速未満にもする)、余裕があれば少しずつ上げる
      const wall = now - windowStartWall;
      if (wall > 1000) {
        const mediaSpan = (mediaMs - windowStartMedia) / 1000;
        const density = mediaSpan > 0 ? windowFrames / mediaSpan : 0;
        const target = 1000 / intervalMs;
        if (density < target * 0.8) rate = Math.max(0.25, rate * Math.max(0.3, density / target));
        else if (density > target * 0.95) rate = Math.min(8, rate * 1.25);
        video.playbackRate = rate;
        windowStartWall = now;
        windowStartMedia = mediaMs;
        windowFrames = 0;
      }
      if (now - lastProgressAt > 250) {
        lastProgressAt = now;
        const d = durationMs();
        opts.onProgress({
          fraction: d ? Math.min(1, mediaMs / d) : null,
          mediaTimeMs: mediaMs,
          durationMs: d,
          playbackRate: rate,
          detectRate: analyzed > 0 ? detected / analyzed : 0,
        });
      }
    });

    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onVisibility);
    signal?.addEventListener("abort", onAbort);
    video.muted = true;
    video.playbackRate = rate;
    video.currentTime = 0;
    void video.play().catch((e) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(e instanceof Error ? e : new Error("動画を再生できません"));
    });
  });
}

/** 動画の先頭付近のフレームで顔を検出する(解析前に候補者を選ぶため) */
export async function detectFacesAt(engine: FaceEngine, video: HTMLVideoElement, timeSec: number): Promise<FaceObservation[]> {
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = Math.max(0, timeSec);
    setTimeout(done, 3000);
  });
  return engine.detectAll(video, performance.now());
}
