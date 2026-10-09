// 録画の送信キュー。端末内(IndexedDB)の録画を、チャンク単位でサーバーへ送る。
// - 録画中から順次送る(終了後の待ち時間を短くする)
// - 通信が切れたら待って再開。サーバー側の受信済みチャンクを確認して続きから送る
// - 送信が済んだら端末内の映像を消す
// 複数タブで開いていても、送信するのは1タブだけ(Web Locks)。

import { api, ApiError } from "../api";
import { localStore, type LocalRecording } from "./localStore";

export type UploadPhase = "waiting" | "uploading" | "finishing" | "done" | "offline" | "login" | "error";

export type UploadState = {
  localId: string;
  interviewId: string;
  candidateName: string;
  recordingStatus: LocalRecording["status"];
  phase: UploadPhase;
  chunkCount: number;
  uploadedChunks: number;
  bytes: number;
  error: string | null;
  serverRecordingId: string | null;
  durationMs: number | null;
  startedAt: string;
};

/** IndexedDB に書けなかったときの退避先(同じタブ内だけ有効) */
export const memoryChunks = new Map<string, Blob>();
const memKey = (localId: string, index: number) => `${localId}:${index}`;

const STALE_HEARTBEAT_MS = 30_000;
const KEEP_DONE_MS = 3 * 24 * 3600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class UploadManager {
  /** このタブで録画中の録画(セッション切れでも画面を移動させないために使う) */
  activeRecording: string | null = null;
  private readonly states = new Map<string, UploadState>();
  private readonly listeners = new Set<() => void>();
  private wake: (() => void) | null = null;
  private started = false;
  private holdingLock = false;
  private paused = new Set<string>();
  private snapshotCache: UploadState[] = [];
  /** サーバーが受信済みのチャンク(毎回問い合わせないよう手元で持つ。エラー時は捨てて取り直す) */
  private readonly receivedCache = new Map<string, Set<number>>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** useSyncExternalStore 用(変更がなければ同じ配列を返す) */
  snapshot = (): UploadState[] => this.snapshotCache;

  get(localId: string): UploadState | null {
    return this.states.get(localId) ?? null;
  }

  private emit(): void {
    this.snapshotCache = [...this.states.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const fn of this.listeners) fn();
  }

  private setState(rec: LocalRecording, patch: Partial<UploadState>): void {
    const prev = this.states.get(rec.localId);
    this.states.set(rec.localId, {
      localId: rec.localId,
      interviewId: rec.interviewId,
      candidateName: rec.candidateName,
      recordingStatus: rec.status,
      phase: prev?.phase ?? "waiting",
      chunkCount: rec.chunkCount,
      uploadedChunks: prev?.uploadedChunks ?? 0,
      bytes: rec.bytes,
      error: prev?.error ?? null,
      serverRecordingId: rec.serverRecordingId,
      durationMs: rec.durationMs,
      startedAt: rec.startedAt,
      ...patch,
    });
    this.emit();
  }

  /** アプリ起動時に1回。落ちた録画の回収と、未送信分の送信開始 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let recs: LocalRecording[] = [];
    try {
      recs = await localStore.listRecordings();
    } catch (e) {
      console.warn("[uploader] 端末内の録画を読めません", e);
      return;
    }
    const now = Date.now();
    for (const r of recs) {
      if (r.status === "recording" && now - r.heartbeatAt > STALE_HEARTBEAT_MS) {
        // ブラウザが落ちた/タブが閉じられた録画。書けたところまでを送る
        const fixed = await localStore.updateRecording(r.localId, (x) => {
          x.status = "stopped";
          x.recovered = true;
          x.endedAt = x.endedAt ?? new Date(x.heartbeatAt).toISOString();
          x.durationMs = x.durationMs ?? Math.max(0, x.heartbeatAt - Date.parse(x.startedAt));
        });
        if (fixed) Object.assign(r, fixed);
      }
      if (r.status === "done" && r.doneAt && now - r.doneAt > KEEP_DONE_MS) {
        await localStore.deleteRecording(r.localId).catch(() => undefined);
        continue;
      }
      this.setState(r, {
        phase: r.status === "done" ? "done" : r.status === "error" ? "error" : "waiting",
        uploadedChunks: r.status === "done" ? r.chunkCount : 0,
        error: r.lastError,
      });
    }
    this.runWithLock();
  }

  private runWithLock(): void {
    const run = () => this.loop().finally(() => (this.holdingLock = false));
    if (navigator.locks?.request) {
      void navigator.locks.request("katibito-uploader", async () => {
        this.holdingLock = true;
        await run();
      });
    } else {
      this.holdingLock = true;
      void run();
    }
  }

  /** 新しい録画やチャンクがあることを知らせる */
  kick(): void {
    this.wake?.();
  }

  /** 録画開始時に登録(録画中から送信を始める) */
  async track(localId: string): Promise<void> {
    const rec = await localStore.getRecording(localId);
    if (rec) this.setState(rec, { phase: "waiting", error: null });
    this.kick();
  }

  async retry(localId: string): Promise<void> {
    this.paused.delete(localId);
    const rec = await localStore.updateRecording(localId, (r) => {
      if (r.status === "error") {
        const stillRecording = !r.endedAt && Date.now() - r.heartbeatAt < STALE_HEARTBEAT_MS;
        r.status = stillRecording ? "recording" : "stopped";
      }
      r.lastError = null;
    });
    if (rec) this.setState(rec, { phase: "waiting", error: null });
    this.kick();
  }

  /** 端末内のデータを破棄する(送信をあきらめる)。サーバーの受信途中のデータも消す */
  async discard(localId: string): Promise<void> {
    this.paused.add(localId);
    const rec = await localStore.getRecording(localId).catch(() => null);
    if (rec?.serverRecordingId && !rec.completed) {
      await api.abortRecording(rec.interviewId, rec.serverRecordingId).catch((e) =>
        console.warn("[uploader] サーバー側の取り消しに失敗", e),
      );
    }
    await localStore.deleteRecording(localId);
    this.states.delete(localId);
    for (const k of memoryChunks.keys()) if (k.startsWith(`${localId}:`)) memoryChunks.delete(k);
    this.emit();
  }

  get pendingCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.phase !== "done") n++;
    return n;
  }

  private async loop(): Promise<void> {
    let backoff = 2000;
    for (;;) {
      let recs: LocalRecording[];
      try {
        recs = (await localStore.listRecordings()).filter(
          (r) => r.status !== "done" && r.status !== "error" && !this.paused.has(r.localId),
        );
      } catch {
        recs = [];
      }
      let progressed = false;
      let waitingForMore = false;
      let failed = false;
      for (const r of recs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        try {
          const res = await this.process(r);
          if (res === "progress") progressed = true;
          if (res === "recording") waitingForMore = true;
          backoff = 2000;
        } catch (e) {
          failed = true;
          await this.handleError(r, e);
        }
      }
      const delay = failed ? backoff : waitingForMore ? 2000 : progressed ? 0 : 30_000;
      if (failed) backoff = Math.min(60_000, backoff * 2);
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  private async handleError(r: LocalRecording, e: unknown): Promise<void> {
    this.receivedCache.delete(r.localId);
    const status = e instanceof ApiError ? e.status : -1;
    const message = (e as Error)?.message ?? String(e);
    if (status === 0 || status === -1 || status >= 500 || status === 429) {
      this.setState(r, { phase: "offline", error: status === 0 ? "通信できません。接続が戻ると自動で再開します" : message });
      return;
    }
    if (status === 401) {
      this.setState(r, { phase: "login", error: "ログインし直すと送信を再開します" });
      return;
    }
    // 403 / 404 / 413 等は再送しても通らない
    await localStore.updateRecording(r.localId, (x) => {
      x.status = "error";
      x.lastError = message;
    });
    this.setState({ ...r, status: "error" }, { phase: "error", error: message });
  }

  /** 1本ぶん進める。戻り値: progress = 何か送った / recording = 録画中で続きを待つ / idle */
  private async process(r0: LocalRecording): Promise<"progress" | "recording" | "idle"> {
    let r = r0;
    let progressed = false;

    if (!r.serverRecordingId) {
      const res = await api.createRecording(r.interviewId, {
        clientId: r.localId,
        source: r.source,
        mimeType: r.mimeType,
        startedAt: r.startedAt,
      });
      r = (await localStore.updateRecording(r.localId, (x) => (x.serverRecordingId = res.recording.id))) ?? r;
      progressed = true;
    }
    const rid = r.serverRecordingId!;

    let received = this.receivedCache.get(r.localId);
    let serverDone = false;
    if (!received) {
      const status = await api.recording(r.interviewId, rid);
      serverDone = status.recording.status !== "uploading";
      received = new Set(status.received);
      if (!serverDone) this.receivedCache.set(r.localId, received);
    }
    this.setState(r, { phase: "uploading", uploadedChunks: serverDone ? r.chunkCount : received.size, error: null });

    if (!serverDone) {
      // 未送信のチャンクを順に送る(録画中なら、書き込み済みのところまで)
      for (let i = 0; i < r.chunkCount; i++) {
        if (received.has(i)) continue;
        const blob = memoryChunks.get(memKey(r.localId, i)) ?? (await localStore.getChunk(r.localId, i));
        if (!blob) throw new Error(`端末内のデータ(${i})が見つかりません`);
        await api.putChunk(r.interviewId, rid, i, blob);
        received.add(i);
        progressed = true;
        this.setState(r, { phase: "uploading", uploadedChunks: received.size });
      }
      const latest = await localStore.getRecording(r.localId);
      if (!latest) return "idle";
      r = latest;
      if (r.status === "recording") return "recording";
      if (received.size < r.chunkCount) return "progress"; // 停止までに増えたぶんを次の周回で送る

      this.setState(r, { phase: "finishing" });
      await api.completeRecording(r.interviewId, rid, {
        chunkCount: r.chunkCount,
        durationMs: r.durationMs !== null ? Math.round(r.durationMs) : null,
        endedAt: r.endedAt ?? new Date().toISOString(),
        markers: r.markers,
      });
      r = (await localStore.updateRecording(r.localId, (x) => (x.completed = true))) ?? r;
      this.receivedCache.delete(r.localId);
      progressed = true;
    } else if (r.status === "recording") {
      return "recording";
    }

    // 表情の計測データ
    if (r.analysisAllowed && r.hasTrack && !r.trackUploaded) {
      this.setState(r, { phase: "finishing" });
      const gz = await localStore.getTrack(r.localId);
      if (gz) {
        try {
          await api.putTrack(r.interviewId, rid, gz);
        } catch (e) {
          // 同意の取り消し等で受け付けられない場合は、映像の送信完了を優先する
          if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 401) throw e;
          await localStore.updateRecording(r.localId, (x) => (x.lastError = `表情データを送信できませんでした: ${e.message}`));
        }
      }
      r = (await localStore.updateRecording(r.localId, (x) => (x.trackUploaded = true))) ?? r;
      progressed = true;
    } else if (!r.completed) {
      // サーバー側で完了済み(別の端末・前回の送信)
      r = (await localStore.updateRecording(r.localId, (x) => (x.completed = true))) ?? r;
    }

    // 完了: 端末内の映像を消す
    await localStore.deleteData(r.localId);
    for (const k of memoryChunks.keys()) if (k.startsWith(`${r.localId}:`)) memoryChunks.delete(k);
    r =
      (await localStore.updateRecording(r.localId, (x) => {
        x.status = "done";
        x.doneAt = Date.now();
      })) ?? r;
    this.setState(r, { phase: "done", uploadedChunks: r.chunkCount, error: r.lastError });
    return progressed ? "progress" : "idle";
  }

  get isActiveUploader(): boolean {
    return this.holdingLock;
  }
}

export const uploader = new UploadManager();
export const memoryChunkKey = memKey;
export { sleep };
