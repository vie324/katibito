// MediaRecorder で録画し、2秒ごとのチャンクを端末内(IndexedDB)に書く。
// 時刻の基準(t = 0)は MediaRecorder の start イベント。表情の計測・質問マーカーも同じ基準で記録する。

import type { FaceTrack } from "../../analysis/faceTrack";
import { encodeFaceTrack } from "../../analysis/faceTrack";
import type { Marker } from "../../shared/types";
import { gzipBytes, localStore, newLocalId, type LocalRecording } from "./localStore";
import { memoryChunkKey, memoryChunks, uploader } from "./uploader";

export const TIMESLICE_MS = 2000;
const HEARTBEAT_MS = 5000;

/** この端末のブラウザで録画できる形式(WebM 優先: どのブラウザでも再生しやすい) */
export function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export type RecorderOptions = {
  interviewId: string;
  candidateName: string;
  analysisAllowed: boolean;
  videoBitsPerSecond: number;
};

export class LocalRecorder {
  readonly localId = newLocalId();
  private rec: MediaRecorder | null = null;
  private index = 0;
  private bytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private startPerf: number | null = null;
  private readonly markers: Marker[] = [];
  private storageWarning: string | null = null;
  private stopped = false;
  onWarning: ((msg: string) => void) | null = null;

  constructor(
    private readonly stream: MediaStream,
    private readonly opts: RecorderOptions,
  ) {}

  /** 録画開始(start イベントまで待つ)。戻り値の時刻が t = 0 */
  async start(): Promise<number> {
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("このブラウザは録画に対応していません。パソコンの Chrome をお使いください");
    const now = new Date().toISOString();
    const meta: LocalRecording = {
      localId: this.localId,
      interviewId: this.opts.interviewId,
      candidateName: this.opts.candidateName,
      source: "live",
      mimeType,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      status: "recording",
      chunkCount: 0,
      bytes: 0,
      serverRecordingId: null,
      markers: [],
      hasTrack: false,
      analysisAllowed: this.opts.analysisAllowed,
      trackUploaded: false,
      completed: false,
      lastError: null,
      heartbeatAt: Date.now(),
      recovered: false,
      doneAt: null,
    };
    await localStore.putRecording(meta);

    const rec = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: this.opts.videoBitsPerSecond,
      audioBitsPerSecond: 64_000,
    });
    this.rec = rec;
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const i = this.index++;
      this.bytes += e.data.size;
      const blob = e.data;
      this.writes = this.writes.then(() => this.persistChunk(i, blob));
    };
    rec.onerror = (e) => {
      const err = (e as unknown as { error?: Error }).error;
      this.onWarning?.(`録画でエラーが発生しました: ${err?.message ?? "不明なエラー"}`);
    };

    const started = new Promise<number>((resolve, reject) => {
      rec.onstart = () => resolve(performance.now());
      setTimeout(() => reject(new Error("録画を開始できませんでした")), 5000);
    });
    rec.start(TIMESLICE_MS);
    this.startPerf = await started;

    this.heartbeat = setInterval(() => {
      void localStore
        .updateRecording(this.localId, (r) => {
          r.heartbeatAt = Date.now();
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);

    await uploader.track(this.localId);
    return this.startPerf;
  }

  private async persistChunk(i: number, blob: Blob): Promise<void> {
    try {
      await localStore.putChunk(this.localId, i, blob);
    } catch (e) {
      // 端末の容量不足など。送信が終わるまでメモリに退避する(このタブを閉じると失われる)
      memoryChunks.set(memoryChunkKey(this.localId, i), blob);
      if (!this.storageWarning) {
        this.storageWarning = "端末に録画を保存できません(空き容量不足の可能性)。このタブを閉じずに送信の完了を待ってください";
        this.onWarning?.(this.storageWarning);
        console.warn("[recorder] IndexedDB に書けません", e);
      }
    }
    await localStore
      .updateRecording(this.localId, (r) => {
        r.chunkCount = Math.max(r.chunkCount, i + 1);
        r.bytes = this.bytes;
        r.heartbeatAt = Date.now();
      })
      .catch(() => undefined);
    uploader.kick();
  }

  get t0(): number | null {
    return this.startPerf;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  elapsedMs(): number {
    return this.startPerf === null ? 0 : performance.now() - this.startPerf;
  }

  get recordedBytes(): number {
    return this.bytes;
  }

  get chunkCount(): number {
    return this.index;
  }

  addMarker(kind: Marker["kind"], label: string): Marker {
    const m: Marker = { id: newLocalId().slice(0, 12), tMs: Math.round(this.elapsedMs()), kind, label };
    this.markers.push(m);
    const snapshot = [...this.markers];
    void localStore.updateRecording(this.localId, (r) => (r.markers = snapshot)).catch(() => undefined);
    return m;
  }

  removeMarker(id: string): void {
    const i = this.markers.findIndex((m) => m.id === id);
    if (i >= 0) this.markers.splice(i, 1);
    const snapshot = [...this.markers];
    void localStore.updateRecording(this.localId, (r) => (r.markers = snapshot)).catch(() => undefined);
  }

  get markerList(): Marker[] {
    return [...this.markers];
  }

  /** 録画中の顔トラックを定期保存する(落ちても計測データが残るように) */
  async saveTrack(track: FaceTrack): Promise<void> {
    const gz = await gzipBytes(encodeFaceTrack(track));
    await localStore.putTrack(this.localId, gz);
    await localStore.updateRecording(this.localId, (r) => (r.hasTrack = true));
  }

  async stop(finalTrack: FaceTrack | null): Promise<LocalRecording | null> {
    if (this.stopped) return localStore.getRecording(this.localId);
    this.stopped = true;
    const durationMs = Math.round(this.elapsedMs());
    const rec = this.rec;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
    }
    await this.writes;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (finalTrack && finalTrack.count > 0 && this.opts.analysisAllowed) {
      await this.saveTrack(finalTrack).catch((e) => console.warn("[recorder] 顔トラックを保存できません", e));
    }
    const saved = await localStore.updateRecording(this.localId, (r) => {
      r.status = "stopped";
      r.endedAt = new Date().toISOString();
      r.durationMs = durationMs;
      r.markers = [...this.markers];
      r.chunkCount = Math.max(r.chunkCount, this.index);
      r.heartbeatAt = Date.now();
    });
    uploader.kick();
    return saved;
  }

  /** 録画を破棄する(開始直後のやり直しなど) */
  async discard(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const rec = this.rec;
    if (rec && rec.state !== "inactive") {
      rec.ondataavailable = null;
      rec.stop();
    }
    await this.writes.catch(() => undefined);
    await uploader.discard(this.localId);
  }
}
