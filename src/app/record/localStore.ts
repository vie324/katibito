// 端末内の録画データ(IndexedDB)。
// 録画中のチャンクは届いた順にここへ書き、送信が済んだら消す。
// ブラウザが落ちても、次にアプリを開いたときに続きから送信できる。

import type { Marker } from "../../shared/types";

export type LocalStatus = "recording" | "stopped" | "done" | "error";

export type LocalRecording = {
  /** 端末側ID(サーバーの clientId) */
  localId: string;
  interviewId: string;
  candidateName: string;
  source: "live" | "file";
  mimeType: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: LocalStatus;
  /** 書き込み済みのチャンク数 */
  chunkCount: number;
  bytes: number;
  serverRecordingId: string | null;
  markers: Marker[];
  /** 表情の計測データ(顔トラック)があるか */
  hasTrack: boolean;
  analysisAllowed: boolean;
  trackUploaded: boolean;
  completed: boolean;
  lastError: string | null;
  /** 録画中は数秒ごとに更新(止まっていればブラウザが落ちたと判断する) */
  heartbeatAt: number;
  /** ブラウザが落ちた録画を回収したもの */
  recovered: boolean;
  doneAt: number | null;
  /** 端末にもサーバーにもないチャンクの番号(送信できない。手前までで完了するか破棄する) */
  missingChunk?: number | null;
  /** サーバー側で失敗扱いになっている(新しい録画として送り直せる) */
  serverFailed?: boolean;
  /** 送り直した回数。サーバー上の録画ID(clientId)を変えるのに使う */
  uploadAttempt?: number;
};

const DB_NAME = "katibito-local";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "localId" });
        if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks");
        if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けません"));
      req.onblocked = () => reject(new Error("IndexedDB が他のタブで使用中です"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB の操作に失敗しました"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB の書き込みに失敗しました"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB の書き込みが中断されました"));
  });
}

const chunkKey = (localId: string, index: number) => `${localId}:${String(index).padStart(6, "0")}`;

export const localStore = {
  async putRecording(rec: LocalRecording): Promise<void> {
    const db = await openDb();
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").put(rec);
    await txDone(tx);
  },

  async getRecording(localId: string): Promise<LocalRecording | null> {
    const db = await openDb();
    return ((await done(db.transaction("recordings").objectStore("recordings").get(localId))) as LocalRecording) ?? null;
  },

  async listRecordings(): Promise<LocalRecording[]> {
    const db = await openDb();
    return (await done(db.transaction("recordings").objectStore("recordings").getAll())) as LocalRecording[];
  },

  /** 読み込み → 変更 → 保存を1つのトランザクションで行う */
  async updateRecording(localId: string, fn: (r: LocalRecording) => void): Promise<LocalRecording | null> {
    const db = await openDb();
    const tx = db.transaction("recordings", "readwrite");
    const store = tx.objectStore("recordings");
    const rec = (await done(store.get(localId))) as LocalRecording | undefined;
    if (!rec) {
      await txDone(tx).catch(() => undefined);
      return null;
    }
    fn(rec);
    store.put(rec);
    await txDone(tx);
    return rec;
  },

  async putChunk(localId: string, index: number, blob: Blob): Promise<void> {
    const db = await openDb();
    const tx = db.transaction("chunks", "readwrite");
    tx.objectStore("chunks").put(blob, chunkKey(localId, index));
    await txDone(tx);
  },

  async getChunk(localId: string, index: number): Promise<Blob | null> {
    const db = await openDb();
    return ((await done(db.transaction("chunks").objectStore("chunks").get(chunkKey(localId, index)))) as Blob) ?? null;
  },

  async putTrack(localId: string, gz: Blob): Promise<void> {
    const db = await openDb();
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").put(gz, localId);
    await txDone(tx);
  },

  async getTrack(localId: string): Promise<Blob | null> {
    const db = await openDb();
    return ((await done(db.transaction("tracks").objectStore("tracks").get(localId))) as Blob) ?? null;
  },

  /** 送信が済んだ映像と顔トラックを消す(メタデータは「送信済み」表示のために残す) */
  async deleteData(localId: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(["chunks", "tracks"], "readwrite");
    tx.objectStore("chunks").delete(IDBKeyRange.bound(`${localId}:`, `${localId}:￿`));
    tx.objectStore("tracks").delete(localId);
    await txDone(tx);
  },

  async deleteRecording(localId: string): Promise<void> {
    await this.deleteData(localId);
    const db = await openDb();
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").delete(localId);
    await txDone(tx);
  },
};

export function newLocalId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 端末の空き容量(取れないブラウザでは null) */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || e.quota === undefined) return null;
    return { usage: e.usage ?? 0, quota: e.quota };
  } catch {
    return null;
  }
}

/** ブラウザに勝手に消されないよう、永続化を要求する(許可されなくても動く) */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function gzipBytes(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

export async function gunzipToBytes(data: ArrayBuffer | Blob): Promise<Uint8Array> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
