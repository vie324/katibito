// 録画の送信キュー。端末内(IndexedDB)の録画を、チャンク単位でサーバーへ送る。
// - 録画中から順次送る(終了後の待ち時間を短くする)
// - 通信が切れたら待って再開。サーバー側の受信済みチャンクを確認して続きから送る
// - サーバーで再生できるようになった(ready)のを確かめてから、端末内の映像を消す
// - 送り直しても解決しない問題(端末内のデータの欠け、サーバー側での失敗扱い)は「送信できません」で止め、
//   端末内のデータは消さずに残す
// 複数タブで開いていても、送信するのは1タブだけ(Web Locks)。

import type { RecordingMeta } from "../../shared/types";
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
  /** 端末にもサーバーにもないチャンクの番号。0 より大きければ「届いている部分だけで完了」できる */
  missingChunk: number | null;
  /** サーバー側で失敗扱いになっており、新しい録画として送り直せる */
  canResend: boolean;
};

/** IndexedDB に書けなかったときの退避先(同じタブ内だけ有効) */
export const memoryChunks = new Map<string, Blob>();
const memKey = (localId: string, index: number) => `${localId}:${index}`;

const STALE_HEARTBEAT_MS = 30_000;
const KEEP_DONE_MS = 3 * 24 * 3600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 録画中を示すロックの名前。録画しているタブが持ち、タブが閉じたり落ちたりすると自動で外れる */
export const recordingLockName = (localId: string) => `katibito-rec:${localId}`;

/** サーバー上の録画の ID(送信の合言葉を兼ねる)。送り直すたびに変える(失敗扱いの録画と区別するため) */
export function serverClientId(r: Pick<LocalRecording, "localId" | "uploadAttempt">): string {
  const n = r.uploadAttempt ?? 0;
  return n > 0 ? `${r.localId}-${n}` : r.localId;
}

/** 送り直しても解決しない問題 */
class UploadProblem extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "server-failed" | "server-gone" | "mismatch",
    readonly index: number | null = null,
  ) {
    super(message);
  }
}

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
  private flushing = false;

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
      missingChunk: rec.status === "error" ? (rec.missingChunk ?? null) : null,
      canResend: rec.status === "error" && !!rec.serverFailed,
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
      const fixed = await this.recoverIfStale(r).catch(() => null);
      if (fixed) Object.assign(r, fixed);
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

  /** 録画がまだ続いているか(このタブ・別のタブのどちらでも) */
  private async recordingAlive(r: LocalRecording): Promise<boolean> {
    if (r.status !== "recording") return false;
    if (r.localId === this.activeRecording) return true;
    if (Date.now() - r.heartbeatAt <= STALE_HEARTBEAT_MS) return true;
    try {
      const q = await navigator.locks?.query?.();
      if (q?.held?.some((l) => l.name === recordingLockName(r.localId))) return true;
    } catch {
      // ロックを調べられないブラウザでは、更新が止まっているかどうかだけで判断する
    }
    return false;
  }

  /**
   * 「録画中」のまま更新が止まった録画(ブラウザが落ちた・タブが閉じられた・終了処理の書き込みに失敗した)を
   * 停止済みとして扱い、書けたところまでを送れるようにする
   */
  private async recoverIfStale(r: LocalRecording): Promise<LocalRecording | null> {
    if (r.status !== "recording" || (await this.recordingAlive(r))) return null;
    return localStore.updateRecording(r.localId, (x) => {
      if (x.status !== "recording") return;
      x.status = "stopped";
      x.recovered = true;
      x.endedAt = x.endedAt ?? new Date(x.heartbeatAt).toISOString();
      x.durationMs = x.durationMs ?? Math.max(0, x.heartbeatAt - Date.parse(x.startedAt));
    });
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
    // 送信を担当しているのが別のタブなら、メモリに退避したチャンクはこのタブから直接送る
    if (!this.holdingLock && memoryChunks.size > 0) void this.flushMemoryChunks();
  }

  /** 録画開始時に登録(録画中から送信を始める) */
  async track(localId: string): Promise<void> {
    const rec = await localStore.getRecording(localId);
    if (rec) this.setState(rec, { phase: "waiting", error: null });
    this.kick();
  }

  async retry(localId: string): Promise<void> {
    this.paused.delete(localId);
    this.receivedCache.delete(localId);
    const rec = await localStore.updateRecording(localId, (r) => {
      if (r.status === "error") {
        const stillRecording = !r.endedAt && Date.now() - r.heartbeatAt < STALE_HEARTBEAT_MS;
        r.status = stillRecording ? "recording" : "stopped";
      }
      r.lastError = null;
      r.missingChunk = null;
      r.serverFailed = false;
    });
    if (rec) this.setState(rec, { phase: "waiting", error: null });
    this.kick();
  }

  /**
   * 端末内のデータが欠けているとき: 欠けた位置の手前までで録画を完了する。
   * 欠けた位置より後ろは送れないため失われる
   */
  async completePartial(localId: string): Promise<void> {
    this.receivedCache.delete(localId);
    const rec = await localStore.updateRecording(localId, (r) => {
      if (r.status !== "error" || !r.missingChunk || r.missingChunk <= 0) return;
      r.chunkCount = r.missingChunk;
      r.durationMs = null; // サーバーが映像から長さを求める
      r.missingChunk = null;
      r.status = "stopped";
      r.lastError = null;
    });
    if (rec) this.setState(rec, { phase: "waiting", error: null, uploadedChunks: 0 });
    this.paused.delete(localId);
    this.kick();
  }

  /** サーバー側で失敗扱いになった録画を、新しい録画として最初から送り直す */
  async resend(localId: string): Promise<void> {
    this.receivedCache.delete(localId);
    const rec = await localStore.updateRecording(localId, (r) => {
      if (r.status !== "error" || !r.serverFailed) return;
      r.uploadAttempt = (r.uploadAttempt ?? 0) + 1;
      r.serverRecordingId = null;
      r.completed = false;
      r.trackUploaded = false;
      r.serverFailed = false;
      r.status = "stopped";
      r.lastError = null;
    });
    if (rec) this.setState(rec, { phase: "waiting", error: null, uploadedChunks: 0 });
    this.paused.delete(localId);
    this.kick();
  }

  /** 端末内のデータを破棄する(送信をあきらめる)。サーバーの受信途中のデータも消す */
  async discard(localId: string): Promise<void> {
    this.paused.add(localId);
    const rec = await localStore.getRecording(localId).catch(() => null);
    if (rec?.serverRecordingId && !rec.completed) {
      await api.abortRecording(rec.interviewId, rec.serverRecordingId, serverClientId(rec)).catch((e) =>
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
          if (res === "recording" || res === "waiting") waitingForMore = true;
          backoff = 2000;
        } catch (e) {
          if (!(e instanceof UploadProblem)) failed = true;
          await this.handleError(r, e);
        }
      }
      const delay = failed ? backoff : progressed ? 0 : waitingForMore ? 2000 : 30_000;
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
    if (e instanceof UploadProblem) {
      // 端末内のデータは消さずに残す
      const saved = await localStore
        .updateRecording(r.localId, (x) => {
          x.status = "error";
          x.lastError = e.message;
          x.missingChunk = e.kind === "missing" ? e.index : null;
          x.serverFailed = e.kind === "server-failed";
        })
        .catch(() => null);
      this.setState(saved ?? { ...r, status: "error" }, {
        phase: "error",
        error: e.message,
        missingChunk: e.kind === "missing" ? e.index : null,
        canResend: e.kind === "server-failed",
      });
      return;
    }
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
    // 403 / 404 / 409 / 413 等は再送しても通らない
    await localStore.updateRecording(r.localId, (x) => {
      x.status = "error";
      x.lastError = message;
      x.missingChunk = null;
      x.serverFailed = false;
    });
    this.setState({ ...r, status: "error" }, { phase: "error", error: message, missingChunk: null, canResend: false });
  }

  /**
   * 1本ぶん進める。戻り値:
   * progress = 何か送った / recording = 録画中で続きを待つ / waiting = サーバーの処理待ち / idle
   */
  private async process(r0: LocalRecording): Promise<"progress" | "recording" | "waiting" | "idle"> {
    let r = r0;
    let progressed = false;
    const clientId = serverClientId(r);

    if (!r.serverRecordingId) {
      const res = await api.createRecording(r.interviewId, {
        clientId,
        source: r.source,
        mimeType: r.mimeType,
        startedAt: r.startedAt,
      });
      r = (await localStore.updateRecording(r.localId, (x) => (x.serverRecordingId = res.recording.id))) ?? r;
      progressed = true;
    }
    const rid = r.serverRecordingId!;

    // サーバー側の状態(受信済みチャンクを手元に持っていれば、受信中とみなして問い合わせない)
    let server: RecordingMeta | null = null;
    let received = this.receivedCache.get(r.localId) ?? null;
    if (!received) {
      const st = await api.recording(r.interviewId, rid);
      server = st.recording;
      if (server.status === "uploading") {
        received = new Set(st.received);
        this.receivedCache.set(r.localId, received);
      }
    }

    if (received) {
      this.setState(r, { phase: "uploading", uploadedChunks: received.size, error: null });
      // 未送信のチャンクを順に送る(録画中なら、書き込み済みのところまで)
      for (let i = 0; i < r.chunkCount; i++) {
        if (received.has(i)) continue;
        const blob = memoryChunks.get(memKey(r.localId, i)) ?? (await localStore.getChunk(r.localId, i));
        if (!blob) {
          // 録画しているタブがメモリから直接送った可能性がある。サーバーの受信状況を取り直して確かめる
          const st = await api.recording(r.interviewId, rid);
          if (st.recording.status === "uploading" && st.received.includes(i)) {
            received = new Set(st.received);
            this.receivedCache.set(r.localId, received);
            continue;
          }
          const latest = (await localStore.getRecording(r.localId)) ?? r;
          if (await this.recordingAlive(latest)) return "recording"; // 録画中のタブがまだ持っている
          // 録画を終えた直後は、録画したタブがメモリから送り終えるのを少し待つ
          if (latest.endedAt && !latest.recovered && Date.now() - Date.parse(latest.endedAt) < 60_000) return "waiting";
          throw new UploadProblem(
            i > 0
              ? `端末内の録画データの一部(${i + 1}番目以降)が失われています。「届いている部分で完了」で、その手前までを送れます`
              : "端末内の録画データが失われています。破棄してください",
            "missing",
            i,
          );
        }
        await api.putChunk(r.interviewId, rid, clientId, i, blob);
        received.add(i);
        progressed = true;
        this.setState(r, { phase: "uploading", uploadedChunks: received.size });
      }
      const latest = await localStore.getRecording(r.localId);
      if (!latest) return "idle";
      r = (await this.recoverIfStale(latest)) ?? latest;
      if (r.status === "recording") return "recording";
      // 停止までに増えたぶんは次の周回で送る
      for (let i = 0; i < r.chunkCount; i++) if (!received.has(i)) return "progress";
      if (r.chunkCount === 0) {
        throw new UploadProblem("録画データがありません(録画の開始直後に止まった可能性があります)。破棄してください", "missing", 0);
      }

      this.setState(r, { phase: "finishing" });
      const res = await api.completeRecording(r.interviewId, rid, clientId, {
        chunkCount: r.chunkCount,
        durationMs: r.durationMs !== null ? Math.round(r.durationMs) : null,
        endedAt: r.endedAt ?? new Date().toISOString(),
        markers: r.markers,
      });
      server = res.recording;
      r = (await localStore.updateRecording(r.localId, (x) => (x.completed = true))) ?? r;
      this.receivedCache.delete(r.localId);
      progressed = true;
    }
    if (!server) return progressed ? "progress" : "idle";

    // ここから先、サーバーは受信を終えている
    if (server.status === "failed") {
      throw new UploadProblem(
        `サーバー側で録画が失敗扱いになっています(${server.error ?? "原因不明"})。端末内のデータは残しています。管理者が再処理できない場合は「送り直す」を押してください`,
        "server-failed",
      );
    }
    if (server.status === "purged" || server.status === "deleted") {
      throw new UploadProblem("サーバー側で録画が削除されています(同意の取り消し・管理者による削除など)。端末内のデータは残しています", "server-gone");
    }
    if (server.status === "uploading") return "progress"; // 次の周回で受信状況から続ける
    if (server.chunkCount !== null && server.chunkCount < r.chunkCount) {
      throw new UploadProblem("サーバーの録画が端末の録画より短くなっています。端末内のデータは残しています。管理者に連絡してください", "mismatch");
    }

    // 表情の計測データ
    if (r.analysisAllowed && r.hasTrack && !r.trackUploaded) {
      this.setState(r, { phase: "finishing" });
      const gz = await localStore.getTrack(r.localId);
      if (gz) {
        try {
          await api.putTrack(r.interviewId, rid, gz, clientId);
        } catch (e) {
          // 同意の取り消し等で受け付けられない場合は、映像の送信完了を優先する
          if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 429) throw e;
          await localStore.updateRecording(r.localId, (x) => (x.lastError = `表情データを送信できませんでした: ${e.message}`));
        }
      }
      r = (await localStore.updateRecording(r.localId, (x) => (x.trackUploaded = true))) ?? r;
      progressed = true;
    }
    if (!r.completed) {
      // サーバー側で完了済み(前回の送信で完了の応答を受け取れなかった等)
      r = (await localStore.updateRecording(r.localId, (x) => (x.completed = true))) ?? r;
    }

    // サーバーで仕上げ中: 再生できるようになるまで端末内のデータは消さない
    if (server.status === "processing") {
      this.setState(r, { phase: "finishing", uploadedChunks: r.chunkCount, error: null });
      return progressed ? "progress" : "waiting";
    }

    // 完了(再生できる): 端末内の映像を消す
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

  /**
   * メモリに退避したチャンク(端末に保存できなかったもの)を、このタブから直接送る。
   * 送信を担当しているのが別のタブだと、そのタブからはこのメモリを読めないため
   */
  private async flushMemoryChunks(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let pass = 0; pass < 100 && memoryChunks.size > 0 && !this.holdingLock; pass++) {
        let sent = 0;
        for (const key of [...memoryChunks.keys()]) {
          const [localId, idx] = key.split(":");
          const blob = memoryChunks.get(key);
          const rec = await localStore.getRecording(localId).catch(() => null);
          if (!blob || !rec || rec.status === "done") {
            memoryChunks.delete(key);
            continue;
          }
          if (!rec.serverRecordingId) continue; // 送信担当のタブがサーバーに録画を作るのを待つ
          try {
            await api.putChunk(rec.interviewId, rec.serverRecordingId, serverClientId(rec), Number(idx), blob);
            memoryChunks.delete(key);
            sent++;
          } catch (e) {
            console.warn("[uploader] 退避したデータを送れません", e);
          }
        }
        if (memoryChunks.size === 0) break;
        await sleep(sent > 0 ? 500 : 5000);
      }
    } finally {
      this.flushing = false;
    }
  }

  get isActiveUploader(): boolean {
    return this.holdingLock;
  }
}

export const uploader = new UploadManager();
export const memoryChunkKey = memKey;
export { sleep };
