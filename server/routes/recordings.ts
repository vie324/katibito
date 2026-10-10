// 録画の API: 作成 → チャンク送信(再開可能)→ 完了 → 結合・索引付け(バックグラウンド)。
// 顔トラック(表情の計測データ)の受け取りと集計、動画の配信(Range 対応)。

import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Marker, RecordingMeta } from "../../src/shared/types";
import { arr, int, isoDate, obj, oneOf, str, ValidationError } from "../../src/shared/validate";
import type { AppContext } from "../context";
import { HANDLED, HttpError, readBinary, readJson, type Router } from "../http";
import { sendFileRange, servingType } from "../media";
import { MP4_FILE } from "../transcode";
import { readTranscript, scheduleTranscription, transcriptionStatus } from "../transcribe";
import {
  canReprocess,
  chunkFile,
  chunksDir,
  decodeTrackGz,
  deleteRecordingFiles,
  finalizeRecording,
  liveInfo,
  loadSummary,
  publicRecording,
  receivedChunks,
  recomputeSummary,
  TRACK_FILE,
  videoPath,
  writeTrack,
} from "../recordings";
import { newId } from "../store";
import { audit, auditView, getInterview } from "./interviews";
import { notifyLiveStarted } from "../notifications";

const MAX_RECORDINGS = 20;
const MAX_CHUNKS = 100_000;
const MAX_DURATION_MS = 4 * 3600_000;

function getRecording(app: AppContext, iid: string, rid: string): RecordingMeta {
  const iv = getInterview(app, iid);
  const rec = iv.recordings.find((r) => r.id === rid);
  if (!rec) throw new HttpError(404, "録画が見つかりません");
  return rec;
}

export function parseMarkers(v: unknown): Marker[] {
  return arr(v, "マーカー", 500, (x, i) => {
    const o = obj(x, `マーカー${i + 1}`);
    const mid = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : newId(6);
    return {
      id: mid,
      tMs: int(o.tMs, "マーカーの時刻", { min: 0, max: MAX_DURATION_MS })!,
      kind: oneOf(o.kind, "マーカーの種類", ["question", "bookmark"] as const),
      label: str(o.label, "マーカーの名前", { max: 100, optional: true }),
    };
  }).sort((a, b) => a.tMs - b.tMs);
}

/**
 * 録画した端末(取り込んだ画面)だけが送信を続けられるようにする。
 * 端末側の録画ID(clientId)は応答に含めないので、合言葉として使える
 */
export const CLIENT_ID_HEADER = "x-recording-client-id";

function fromRecordingClient(c: { req: { headers: Record<string, string | string[] | undefined> } }, rec: RecordingMeta): boolean {
  const v = c.req.headers[CLIENT_ID_HEADER];
  return typeof v === "string" && v.length > 0 && v === rec.clientId;
}

function requireRecordingClient(c: Parameters<typeof fromRecordingClient>[0], rec: RecordingMeta): void {
  if (!fromRecordingClient(c, rec)) throw new HttpError(403, "この録画を送信している端末からのみ送信できます");
}

function consentAllows(app: AppContext, iid: string, what: "recording" | "analysis"): void {
  const iv = getInterview(app, iid);
  const c = iv.consent;
  if (!c || !c[what] || (c.withdrawnAt && (c.withdrawnScope === "all" || what === "analysis"))) {
    throw new HttpError(
      403,
      what === "recording" ? "録画への同意が記録されていません" : "表情の計測への同意が記録されていません",
    );
  }
}

export function registerRecordingRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  // ---------------------------------------------------------------- 作成(端末側IDで冪等)
  r.post("/api/interviews/:id/recordings", "user", async (c) => {
    const body = obj(await readJson(c));
    const clientId = str(body.clientId, "端末側の録画ID", { max: 64, min: 6 });
    if (!/^[A-Za-z0-9_-]+$/.test(clientId)) throw new ValidationError("端末側の録画IDが正しくありません");
    const source = oneOf(body.source, "録画の種類", ["live", "file"] as const);
    const mimeType = str(body.mimeType, "形式", { max: 120, min: 3 });
    if (!/^(video|audio)\/[a-z0-9.+-]+(;.*)?$/i.test(mimeType)) throw new ValidationError("動画の形式ではありません");
    const startedAt = isoDate(body.startedAt, "録画開始時刻") ?? new Date().toISOString();
    // 取り込んだ動画の元のファイル名(表示用)。保存名は video.* に統一する
    const fileName = str(body.fileName, "ファイル名", { max: 200, optional: true }) || null;

    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const existing = iv.recordings.find((rec) => rec.clientId === clientId);
      if (existing) {
        return {
          recording: publicRecording(existing),
          received: existing.status === "uploading" ? await receivedChunks(app, iv.id, existing.id) : [],
        };
      }
      consentAllows(app, iv.id, "recording");
      if (iv.decision) throw new HttpError(409, "判定済みの面接には録画を追加できません");
      if (iv.recordings.filter((x) => x.status !== "deleted").length >= MAX_RECORDINGS) {
        throw new HttpError(409, "録画の数が上限に達しています。不要な録画を削除してください");
      }
      const now = new Date().toISOString();
      const rec: RecordingMeta = {
        id: newId(),
        clientId,
        source,
        status: "uploading",
        mimeType,
        fileName: null,
        originalName: fileName,
        startedAt,
        endedAt: null,
        durationMs: null,
        chunkCount: null,
        sizeBytes: null,
        indexed: false,
        mp4Ready: false,
        markers: [],
        analysis: "none",
        transcript: "none",
        transcriptError: null,
        createdBy: c.user!.id,
        createdByName: c.user!.name,
        createdAt: now,
        error: null,
        purgedAt: null,
      };
      iv.recordings.push(rec);
      await mkdir(chunksDir(app, iv.id, rec.id), { recursive: true });
      await store.saveInterview(iv);
      await audit(app, c, "recording_start", iv.id, `${source} ${mimeType}`);
      return { recording: publicRecording(rec), received: [] as number[] };
    });
  });

  r.get("/api/interviews/:id/recordings/:rid", "user", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    return {
      recording: publicRecording(rec, liveInfo(app, c.params.id, rec)),
      received: rec.status === "uploading" ? await receivedChunks(app, c.params.id, rec.id) : [],
    };
  });

  // ---------------------------------------------------------------- ライブ(録画中)
  // 録画している端末が数秒ごとに経過時間を知らせる。サーバーはこれで「録画開始の時刻」を推定し、
  // ライブで見ている人のメモの時刻(録画の何分何秒か)を決める
  r.post("/api/interviews/:id/recordings/:rid/live", "user", async (c) => {
    const body = obj(await readJson(c, 16 * 1024));
    const elapsedMs = int(body.elapsedMs, "録画の経過時間", { min: 0, max: MAX_DURATION_MS })!;
    const question = str(body.question, "いまの質問", { max: 100, optional: true }) || null;
    const iv = getInterview(app, c.params.id);
    const rec = getRecording(app, iv.id, c.params.rid);
    requireRecordingClient(c, rec);
    if (rec.status !== "uploading") throw new HttpError(409, "この録画は終わっています");
    const key = `${iv.id}/${rec.id}`;
    const now = Date.now();
    const anchor = now - elapsedMs;
    const prev = app.live.get(key);
    // 通信の遅れのぶん開始時刻は後ろにずれるので、いちばん早い推定を使う(大きくずれたら取り直す)
    const anchorMs = prev && Math.abs(prev.anchorMs - anchor) < 5000 ? Math.min(prev.anchorMs, anchor) : anchor;
    app.live.set(key, { anchorMs, updatedAt: now, question, notified: prev?.notified ?? false });
    if (!prev?.notified) {
      app.live.get(key)!.notified = true;
      void notifyLiveStarted(app, iv, rec.createdBy);
    }
    return { live: liveInfo(app, iv.id, rec, now) };
  });

  // ライブで見る人が、受信済みのチャンクを取りに来る(録画中だけ)
  r.get("/api/interviews/:id/recordings/:rid/chunks/:index", "user", async (c) => {
    const index = int(c.params.index, "チャンク番号", { min: 0, max: MAX_CHUNKS - 1 })!;
    const rec = getRecording(app, c.params.id, c.params.rid);
    if (rec.status !== "uploading") throw new HttpError(404, "録画中ではありません");
    const file = chunkFile(app, c.params.id, rec.id, index);
    try {
      await stat(file);
    } catch {
      throw new HttpError(404, "まだ届いていません");
    }
    if (index === 0) await auditView(app, c, "live_view", c.params.id, rec.id);
    await sendFileRange(c.req, c.res, file, "application/octet-stream", "private, max-age=300");
    return HANDLED;
  });

  // ---------------------------------------------------------------- チャンク
  r.put("/api/interviews/:id/recordings/:rid/chunks/:index", "user", async (c) => {
    const index = int(c.params.index, "チャンク番号", { min: 0, max: MAX_CHUNKS - 1 })!;
    const rec0 = getRecording(app, c.params.id, c.params.rid);
    requireRecordingClient(c, rec0);
    if (rec0.status !== "uploading") {
      // 完了後の再送(通信が切れて応答を受け取れなかった場合など)は成功扱い
      if ((rec0.status === "processing" || rec0.status === "ready") && index < (rec0.chunkCount ?? 0)) {
        c.req.resume();
        return { ok: true, already: true };
      }
      throw new HttpError(409, "この録画はアップロードを受け付けていません");
    }
    const body = await readBinary(c, app.config.maxChunkBytes);
    if (body.length === 0) throw new ValidationError("空のデータです");
    // 書き込みはロック内で。受信中に録画・面接が削除されていたら書かない(消したディレクトリを作り直さない)
    return store.withLock(c.params.id, async () => {
      const rec = store.interviews.get(c.params.id)?.recordings.find((x) => x.id === c.params.rid);
      if (!rec || rec.status !== "uploading") throw new HttpError(409, "この録画はアップロードを受け付けていません");
      const file = chunkFile(app, c.params.id, rec.id, index);
      const tmp = `${file}.${newId(4)}.tmp`;
      try {
        await writeFile(tmp, body);
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, "この録画はアップロードを受け付けていません");
        throw e;
      }
      return { ok: true, index, bytes: body.length };
    });
  });

  // ---------------------------------------------------------------- 完了
  r.post("/api/interviews/:id/recordings/:rid/complete", "user", async (c) => {
    const body = obj(await readJson(c, 512 * 1024));
    const chunkCount = int(body.chunkCount, "チャンク数", { min: 1, max: MAX_CHUNKS })!;
    const durationMs = int(body.durationMs, "録画の長さ", { min: 0, max: MAX_DURATION_MS, optional: true });
    const endedAt = isoDate(body.endedAt, "録画終了時刻") ?? new Date().toISOString();
    const markers = body.markers === undefined ? null : parseMarkers(body.markers);

    const rec = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      requireRecordingClient(c, rec);
      if (rec.status === "processing" || rec.status === "ready") return rec;
      if (rec.status !== "uploading") throw new HttpError(409, "この録画は完了できません");
      const got = new Set(await receivedChunks(app, iv.id, rec.id));
      const missing: number[] = [];
      for (let i = 0; i < chunkCount && missing.length < 20; i++) if (!got.has(i)) missing.push(i);
      if (missing.length > 0) {
        throw new HttpError(409, `未送信のデータがあります(${missing.length}件以上)。送信を再開してください`);
      }
      rec.status = "processing";
      app.live.delete(`${iv.id}/${rec.id}`);
      rec.chunkCount = chunkCount;
      rec.durationMs = durationMs;
      rec.endedAt = endedAt;
      if (markers) rec.markers = markers;
      await store.saveInterview(iv);
      await audit(app, c, "recording_complete", iv.id, `${chunkCount} chunks`);
      return rec;
    });
    void app.jobs.run(`finalize:${c.params.id}:${rec.id}`, () => finalizeRecording(app, c.params.id, rec.id));
    return { recording: publicRecording(rec) };
  });

  // 仕上げに失敗した録画を、受信済みのデータからやり直す(空き容量不足を解消したあと等)
  r.post("/api/interviews/:id/recordings/:rid/reprocess", "admin", async (c) => {
    const rec = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      if (!(await canReprocess(app, iv.id, rec))) {
        throw new HttpError(409, "受信したデータが残っていないため、この録画は再処理できません");
      }
      rec.status = "processing";
      rec.error = null;
      await store.saveInterview(iv);
      await audit(app, c, "recording_reprocess", iv.id, rec.id);
      return rec;
    });
    void app.jobs.run(`finalize:${c.params.id}:${rec.id}`, () => finalizeRecording(app, c.params.id, rec.id));
    return { recording: publicRecording(rec) };
  });

  // ---------------------------------------------------------------- マーカー
  r.put("/api/interviews/:id/recordings/:rid/markers", "user", async (c) => {
    const body = obj(await readJson(c, 512 * 1024));
    const markers = parseMarkers(body.markers);
    const rec = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      if (rec.status === "deleted") throw new HttpError(409, "削除された録画です");
      rec.markers = markers;
      await store.saveInterview(iv);
      return rec;
    });
    const summary = rec.analysis === "ready" ? await recomputeSummary(app, c.params.id, rec.id) : null;
    return { recording: publicRecording(rec), summary };
  });

  // ---------------------------------------------------------------- 顔トラック(表情の計測データ)
  const TRACK_STATUSES: RecordingMeta["status"][] = ["uploading", "processing", "ready"];

  r.put("/api/interviews/:id/recordings/:rid/track", "user", async (c) => {
    consentAllows(app, c.params.id, "analysis");
    const rec0 = getRecording(app, c.params.id, c.params.rid);
    if (!TRACK_STATUSES.includes(rec0.status)) throw new HttpError(409, "この録画には登録できません");
    // 録画した端末からの送信と、まだ計測していない録画の計測は誰でも。計測し直し(上書き)は管理者のみ
    if (!fromRecordingClient(c, rec0) && rec0.analysis === "ready" && c.user!.role !== "admin") {
      throw new HttpError(403, "表情の計測し直しは管理者のみ実行できます");
    }
    const gz = await readBinary(c, app.config.maxTrackBytes);
    let track;
    try {
      track = decodeTrackGz(gz);
    } catch (e) {
      throw new HttpError(400, `表情の計測データを読めません: ${(e as Error).message}`);
    }
    return store.withLock(c.params.id, async () => {
      // 受信中に同意の取り消し・録画の削除があれば保存しない
      consentAllows(app, c.params.id, "analysis");
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      if (!TRACK_STATUSES.includes(rec.status)) throw new HttpError(409, "この録画には登録できません");
      let summary;
      try {
        summary = await writeTrack(app, iv.id, rec, gz, track);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(409, "この録画には登録できません");
        throw e;
      }
      rec.analysis = "ready";
      await store.saveInterview(iv);
      await audit(app, c, "analysis_upload", iv.id, `${summary.frameCount} frames`);
      return { recording: publicRecording(rec), summary };
    });
  });

  r.get("/api/interviews/:id/recordings/:rid/track", "user", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    if (rec.analysis !== "ready") throw new HttpError(404, "表情の計測データがありません");
    const file = path.join(store.recordingDir(c.params.id, rec.id), TRACK_FILE);
    try {
      await stat(file);
    } catch {
      throw new HttpError(404, "表情の計測データがありません");
    }
    await sendFileRange(c.req, c.res, file, "application/gzip", "private, no-cache");
    return HANDLED;
  });

  // ---------------------------------------------------------------- 文字起こし
  r.get("/api/interviews/:id/recordings/:rid/transcript", "user", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    if (rec.transcript !== "ready") throw new HttpError(404, "文字起こしはまだありません");
    const transcript = await readTranscript(app, c.params.id, rec.id);
    if (!transcript) throw new HttpError(404, "文字起こしはまだありません");
    await auditView(app, c, "transcript_view", c.params.id, rec.id);
    return { transcript };
  });

  // 文字起こしをやり直す(管理者)。モデルを変えたあとや、失敗したとき
  r.post("/api/interviews/:id/recordings/:rid/transcript", "admin", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    if (rec.status !== "ready") throw new HttpError(409, "再生できる録画だけ文字起こしできます");
    if (rec.transcript === "queued" || rec.transcript === "running") throw new HttpError(409, "文字起こしの順番待ち・処理中です");
    const status = await transcriptionStatus(app);
    if (!status.available) throw new HttpError(409, status.reason ?? "サーバーで文字起こしを使えません");
    if (!(await scheduleTranscription(app, c.params.id, rec.id, true))) {
      throw new HttpError(409, "この録画は文字起こしできません(録画への同意を確認してください)");
    }
    await audit(app, c, "transcript_request", c.params.id, rec.id);
    return { recording: publicRecording(getRecording(app, c.params.id, rec.id)) };
  });

  r.get("/api/interviews/:id/recordings/:rid/summary", "user", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    const summary = await loadSummary(app, c.params.id, rec);
    if (!summary) throw new HttpError(404, "表情の集計がありません");
    return { summary };
  });

  // ---------------------------------------------------------------- 動画
  r.get("/api/interviews/:id/recordings/:rid/video", "user", async (c) => {
    const rec = getRecording(app, c.params.id, c.params.rid);
    const wantMp4 = c.query.get("format") === "mp4";
    let file = rec.status === "ready" ? videoPath(app, c.params.id, rec) : null;
    let type = servingType(rec.mimeType);
    if (file && wantMp4) {
      if (!rec.mp4Ready) throw new HttpError(404, "再生用の MP4 はまだありません");
      file = path.join(store.recordingDir(c.params.id, rec.id), MP4_FILE);
      type = "video/mp4";
    }
    if (!file) throw new HttpError(404, "再生できる録画がありません");
    if (!c.req.headers.range || /^bytes=0-/.test(c.req.headers.range)) {
      await auditView(app, c, "video_view", c.params.id, rec.id);
    }
    await sendFileRange(c.req, c.res, file, type);
    return HANDLED;
  });

  // 端末側で録画を破棄したとき: 受信途中のデータを消す(録画した本人か管理者)
  r.post("/api/interviews/:id/recordings/:rid/abort", "user", async (c) => {
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      if (rec.status !== "uploading") throw new HttpError(409, "送信が完了した録画は取り消せません");
      if (!fromRecordingClient(c, rec) && rec.createdBy !== c.user!.id && c.user!.role !== "admin") {
        throw new HttpError(403, "録画した本人か管理者だけが取り消せます");
      }
      await deleteRecordingFiles(app, iv.id, rec, false);
      app.live.delete(`${iv.id}/${rec.id}`);
      rec.status = "deleted";
      rec.analysis = "none";
      rec.purgedAt = new Date().toISOString();
      rec.error = "録画した端末で破棄されました";
      await store.saveInterview(iv);
      await audit(app, c, "recording_abort", iv.id, rec.id);
      return { recording: publicRecording(rec) };
    });
  });

  r.delete("/api/interviews/:id/recordings/:rid", "admin", async (c) => {
    return store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const rec = getRecording(app, iv.id, c.params.rid);
      if (app.jobs.has(`finalize:${iv.id}:${rec.id}`)) throw new HttpError(409, "処理中です。しばらく待ってから削除してください");
      await deleteRecordingFiles(app, iv.id, rec, false);
      app.live.delete(`${iv.id}/${rec.id}`);
      rec.status = "deleted";
      rec.fileName = null;
      rec.analysis = "none";
      rec.transcript = "none";
      rec.purgedAt = new Date().toISOString();
      await store.saveInterview(iv);
      await audit(app, c, "recording_delete", iv.id, rec.id);
      return { recording: publicRecording(rec) };
    });
  });
}
