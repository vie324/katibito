// 録画まわりの処理: チャンクの結合と WebM の索引付け、表情集計の保存・再計算、削除。

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { computeExpressionSummary, type ExpressionSummary } from "../src/analysis/expression";
import { decodeFaceTrack } from "../src/analysis/faceTrack";
import { INTERVIEW_ANALYSIS } from "../src/config/scoring";
import type { Interview, RecordingMeta } from "../src/shared/types";
import type { AppContext } from "./context";
import { concatFiles, extensionFor, isWebm } from "./media";
import { notifyRecordingReady } from "./notifications";
import { scheduleTranscode } from "./transcode";
import { writeJsonAtomic } from "./store";
import { indexWebm } from "./webm";

export const TRACK_FILE = "track.bin.gz";
export const SUMMARY_FILE = "summary.json";
const MAX_TRACK_RAW = 256 * 1024 * 1024;

export function chunksDir(ctx: AppContext, iid: string, rid: string): string {
  return path.join(ctx.store.recordingDir(iid, rid), "chunks");
}

export function chunkFile(ctx: AppContext, iid: string, rid: string, index: number): string {
  return path.join(chunksDir(ctx, iid, rid), `${String(index).padStart(6, "0")}.part`);
}

export async function receivedChunks(ctx: AppContext, iid: string, rid: string): Promise<number[]> {
  try {
    return (await readdir(chunksDir(ctx, iid, rid)))
      .filter((f) => /^\d{6}\.part$/.test(f))
      .map((f) => Number(f.slice(0, 6)))
      .sort((a, b) => a - b);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export function videoPath(ctx: AppContext, iid: string, rec: RecordingMeta): string | null {
  if (!rec.fileName) return null;
  return path.join(ctx.store.recordingDir(iid, rec.id), rec.fileName);
}

/** 面接の録画メタを更新して保存する(ロック内で呼ぶこと) */
async function updateRecording(
  ctx: AppContext,
  iid: string,
  rid: string,
  fn: (rec: RecordingMeta, iv: Interview) => void,
): Promise<RecordingMeta | null> {
  const iv = ctx.store.interviews.get(iid);
  const rec = iv?.recordings.find((r) => r.id === rid);
  if (!iv || !rec) return null;
  fn(rec, iv);
  await ctx.store.saveInterview(iv);
  return rec;
}

/**
 * アップロード完了後の仕上げ: チャンクを結合 → WebM なら索引付け → チャンク削除。
 * 失敗しても録画は残す(索引なしでも再生はできる)。
 */
export async function finalizeRecording(ctx: AppContext, iid: string, rid: string): Promise<void> {
  const iv = ctx.store.interviews.get(iid);
  const rec = iv?.recordings.find((r) => r.id === rid);
  if (!iv || !rec || rec.status !== "processing") return;

  const dir = ctx.store.recordingDir(iid, rid);
  const ext = extensionFor(rec.mimeType);
  const finalName = `video.${ext}`;
  const raw = path.join(dir, "video.raw");
  try {
    const chunks = await receivedChunks(ctx, iid, rid);
    const count = rec.chunkCount ?? 0;
    for (let i = 0; i < count; i++) {
      if (chunks[i] !== i) throw new Error(`チャンク ${i} がありません`);
    }
    const files = chunks.slice(0, count).map((i) => chunkFile(ctx, iid, rid, i));
    await concatFiles(files, raw);

    let indexed = false;
    let durationMs = rec.durationMs;
    if (isWebm(rec.mimeType)) {
      const out = path.join(dir, `${finalName}.tmp`);
      try {
        const res = await indexWebm(raw, out);
        await rename(out, path.join(dir, finalName));
        await rm(raw, { force: true });
        indexed = true;
        if (res.durationMs > 0) durationMs = res.durationMs;
        if (res.truncated) console.warn(`[recordings] ${iid}/${rid}: 途中で途切れた録画を切り詰めました`);
      } catch (e) {
        console.warn(`[recordings] ${iid}/${rid}: 索引付けに失敗。元のファイルのまま配信します`, (e as Error).message);
        await rm(out, { force: true });
      }
    }
    if (!indexed) await rename(raw, path.join(dir, finalName));
    const size = (await stat(path.join(dir, finalName))).size;

    const updated = await ctx.store.withLock(iid, () =>
      updateRecording(ctx, iid, rid, (r) => {
        r.status = "ready";
        r.fileName = finalName;
        r.sizeBytes = size;
        r.indexed = indexed;
        r.durationMs = durationMs;
        r.error = null;
      }),
    );
    await rm(chunksDir(ctx, iid, rid), { recursive: true, force: true });

    // 録画の長さが確定したので、先に届いていた顔トラックの集計をやり直す
    if (updated && updated.analysis === "ready") {
      await recomputeSummary(ctx, iid, updated).catch((e) =>
        console.warn(`[recordings] ${iid}/${rid}: 再集計に失敗`, e),
      );
    }
    const latest = ctx.store.interviews.get(iid);
    if (latest && updated) void notifyRecordingReady(ctx, latest, updated);
    void scheduleTranscode(ctx, iid, rid);
  } catch (e) {
    console.error(`[recordings] ${iid}/${rid}: 仕上げに失敗`, e);
    await rm(raw, { force: true }).catch(() => undefined);
    await ctx.store.withLock(iid, () =>
      updateRecording(ctx, iid, rid, (r) => {
        r.status = "failed";
        r.error = (e as Error).message.slice(0, 300);
      }),
    );
  }
}

/** 起動時: 処理途中で止まった録画をやり直し、完了済みの残骸を掃除する */
export async function resumeProcessing(ctx: AppContext): Promise<void> {
  for (const iv of ctx.store.interviews.values()) {
    for (const rec of iv.recordings) {
      if (rec.status === "processing") {
        void ctx.jobs.run(`finalize:${iv.id}:${rec.id}`, () => finalizeRecording(ctx, iv.id, rec.id));
      } else if (rec.status === "ready") {
        await rm(chunksDir(ctx, iv.id, rec.id), { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 表情集計
// ---------------------------------------------------------------------------

const caches = new WeakMap<object, Map<string, ExpressionSummary>>();
function cacheOf(ctx: AppContext): Map<string, ExpressionSummary> {
  let c = caches.get(ctx.store);
  if (!c) {
    c = new Map();
    caches.set(ctx.store, c);
  }
  return c;
}
const cacheKey = (iid: string, rid: string) => `${iid}/${rid}`;

export async function saveTrack(
  ctx: AppContext,
  iid: string,
  rec: RecordingMeta,
  gz: Buffer,
): Promise<ExpressionSummary> {
  const raw = gunzipSync(gz, { maxOutputLength: MAX_TRACK_RAW });
  const track = decodeFaceTrack(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const summary = computeExpressionSummary(track, rec.markers, rec.durationMs);
  const dir = ctx.store.recordingDir(iid, rec.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${TRACK_FILE}.tmp`), gz);
  await rename(path.join(dir, `${TRACK_FILE}.tmp`), path.join(dir, TRACK_FILE));
  await writeJsonAtomic(path.join(dir, SUMMARY_FILE), summary);
  cacheOf(ctx).set(cacheKey(iid, rec.id), summary);
  return summary;
}

export async function readTrackGz(ctx: AppContext, iid: string, rid: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(ctx.store.recordingDir(iid, rid), TRACK_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function recomputeSummary(
  ctx: AppContext,
  iid: string,
  rec: RecordingMeta,
): Promise<ExpressionSummary | null> {
  const gz = await readTrackGz(ctx, iid, rec.id);
  if (!gz) return null;
  const raw = gunzipSync(gz, { maxOutputLength: MAX_TRACK_RAW });
  const track = decodeFaceTrack(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const summary = computeExpressionSummary(track, rec.markers, rec.durationMs);
  await writeJsonAtomic(path.join(ctx.store.recordingDir(iid, rec.id), SUMMARY_FILE), summary);
  cacheOf(ctx).set(cacheKey(iid, rec.id), summary);
  return summary;
}

/** 集計を読む。集計ロジックのバージョンが変わっていれば顔トラックから再計算する。 */
export async function loadSummary(
  ctx: AppContext,
  iid: string,
  rec: RecordingMeta,
): Promise<ExpressionSummary | null> {
  if (rec.analysis !== "ready") return null;
  const key = cacheKey(iid, rec.id);
  let s = cacheOf(ctx).get(key) ?? null;
  if (!s) {
    try {
      s = JSON.parse(await readFile(path.join(ctx.store.recordingDir(iid, rec.id), SUMMARY_FILE), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      s = null;
    }
  }
  if (s && s.analysisVersion !== INTERVIEW_ANALYSIS.VERSION) {
    const re = await recomputeSummary(ctx, iid, rec).catch(() => null);
    if (re) s = re;
  }
  if (s) cacheOf(ctx).set(key, s);
  return s;
}

/** 映像と顔トラックを消す。keepSummary = true なら集計(数値)は残す(保存期間による削除) */
export async function deleteRecordingFiles(
  ctx: AppContext,
  iid: string,
  rec: RecordingMeta,
  keepSummary: boolean,
): Promise<void> {
  const dir = ctx.store.recordingDir(iid, rec.id);
  if (!keepSummary) {
    await rm(dir, { recursive: true, force: true });
    cacheOf(ctx).delete(cacheKey(iid, rec.id));
    return;
  }
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (f === SUMMARY_FILE) continue;
    await rm(path.join(dir, f), { recursive: true, force: true });
  }
}

/** 顔トラックと集計だけを消す(表情の計測への同意の取り消し) */
export async function deleteAnalysisFiles(ctx: AppContext, iid: string, rec: RecordingMeta): Promise<void> {
  const dir = ctx.store.recordingDir(iid, rec.id);
  await rm(path.join(dir, TRACK_FILE), { force: true });
  await rm(path.join(dir, SUMMARY_FILE), { force: true });
  cacheOf(ctx).delete(cacheKey(iid, rec.id));
}

export function forgetSummary(ctx: AppContext, iid: string, rid?: string): void {
  const cache = cacheOf(ctx);
  if (rid) {
    cache.delete(cacheKey(iid, rid));
    return;
  }
  for (const k of cache.keys()) if (k.startsWith(`${iid}/`)) cache.delete(k);
}
