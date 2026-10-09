// 再生用の MP4(H.264 / AAC)を作る(ffmpeg がある場合のみ)。
// WebM(VP8)は iPhone / iPad の Safari で再生できないことがあるため、
// その場にいない担当者がスマートフォンで確認できるよう、どの端末でも再生できる形式を用意する。
// - 元の録画はそのまま残す(MP4 は再生用の複製)
// - 1本ずつ順番に、低い優先度で変換する(API の応答を遅くしない)

import { spawn, spawnSync } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import { setPriority } from "node:os";
import path from "node:path";
import type { AppContext } from "./context";

export const MP4_FILE = "playback.mp4";

let detected: string | null | undefined;

/** 使える ffmpeg のパス。TRANSCODE=0 なら無効 */
export function ffmpegPath(): string | null {
  if (detected !== undefined) return detected;
  const flag = (process.env.TRANSCODE ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return (detected = null);
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    const r = spawnSync(bin, ["-hide_banner", "-version"], { stdio: "ignore", timeout: 5000 });
    detected = r.status === 0 ? bin : null;
  } catch {
    detected = null;
  }
  return detected;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-2000);
    });
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {
      // 優先度を変えられない環境でもそのまま進める
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg が失敗しました (code ${code}): ${err.split("\n").slice(-3).join(" ")}`));
    });
  });
}

/** 変換が必要か(すでに H.264 の MP4 なら不要) */
function needsTranscode(mime: string): boolean {
  return !/^video\/mp4\b/i.test(mime);
}

let queue: Promise<void> = Promise.resolve();

/** 1本ずつ順番に変換する */
export function scheduleTranscode(ctx: AppContext, iid: string, rid: string): Promise<void> {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve();
  const key = `transcode:${iid}:${rid}`;
  if (ctx.jobs.has(key)) return Promise.resolve();
  return ctx.jobs.run(key, () => {
    queue = queue.then(() => transcodeOne(ctx, bin, iid, rid)).catch(() => undefined);
    return queue;
  });
}

async function transcodeOne(ctx: AppContext, bin: string, iid: string, rid: string): Promise<void> {
  const iv = ctx.store.interviews.get(iid);
  const rec = iv?.recordings.find((r) => r.id === rid);
  if (!iv || !rec || rec.status !== "ready" || rec.mp4Ready || !needsTranscode(rec.mimeType)) return;
  if (!rec.fileName) return;
  const src = path.join(ctx.store.recordingDir(iid, rec.id), rec.fileName);
  const dir = path.dirname(src);
  const tmp = path.join(dir, `${MP4_FILE}.tmp.mp4`);
  const durationMin = Math.max(1, (rec.durationMs ?? 60_000) / 60_000);
  try {
    await run(
      bin,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-profile:v", "main", "-pix_fmt", "yuv420p",
        "-vf", "scale='min(1280,iw)':-2",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        "-threads", "2",
        tmp,
      ],
      // 長くても録画時間の3倍 + 5分で打ち切る
      durationMin * 3 * 60_000 + 5 * 60_000,
    );
    // 変換中に録画が削除・保存期間切れになっていないか、ロック内で確かめてから置く
    const size = await ctx.store.withLock(iid, async () => {
      const cur = ctx.store.interviews.get(iid);
      const r = cur?.recordings.find((x) => x.id === rid);
      if (!cur || !r || r.status !== "ready") {
        await rm(tmp, { force: true });
        return null;
      }
      await rename(tmp, path.join(dir, MP4_FILE));
      r.mp4Ready = true;
      await ctx.store.saveInterview(cur);
      return (await stat(path.join(dir, MP4_FILE))).size;
    });
    if (size !== null) console.log(`[transcode] ${iid}/${rid}: 再生用 MP4 を作成しました (${Math.round(size / 1024 / 1024)}MB)`);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    console.warn(`[transcode] ${iid}/${rid}: MP4 を作成できませんでした`, (e as Error).message);
  }
}

/** 起動時: 変換していない録画を変換する */
export function resumeTranscodes(ctx: AppContext): void {
  if (!ffmpegPath()) return;
  for (const iv of ctx.store.interviews.values()) {
    for (const rec of iv.recordings) {
      if (rec.status === "ready" && !rec.mp4Ready && needsTranscode(rec.mimeType)) {
        void scheduleTranscode(ctx, iv.id, rec.id);
      }
    }
  }
}
