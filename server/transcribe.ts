// 文字起こし(whisper.cpp)。録画の音声をサーバーの中で文字にする(外部のサービスには送らない)。
// - whisper-cli が見つかり、設定で有効なら、録画が再生できるようになったあとに順番に処理する
// - モデル(既定 small-q5_1)と無音検出のモデル(silero)は DATA_DIR/models に置く。なければ最初に使うときに取得する
// - 無音検出(VAD)を必ず使う: 使わないと無音の区間で時刻がずれたり、話していない文が作られたりする
// - 低い優先度で1本ずつ処理する(API の応答を遅くしない)

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RecordingMeta, Transcript, TranscriptionStatus, TranscriptSegment } from "../src/shared/types";
import type { AppContext } from "./context";
import { writeJsonAtomic } from "./store";
import { ffmpegPath } from "./transcode";

export const TRANSCRIPT_FILE = "transcript.json";
const VAD_FILE = "ggml-silero-v5.1.2.bin";

type State = {
  cli: string | null | undefined;
  downloading: number | null;
  downloadPromise: Promise<void> | null;
  progress: TranscriptionStatus["progress"];
  queue: Promise<void>;
  queued: number;
  error: string | null;
};

const states = new WeakMap<AppContext, State>();
function stateOf(ctx: AppContext): State {
  let s = states.get(ctx);
  if (!s) {
    s = { cli: undefined, downloading: null, downloadPromise: null, progress: null, queue: Promise.resolve(), queued: 0, error: null };
    states.set(ctx, s);
  }
  return s;
}

function modelsDir(ctx: AppContext): string {
  return ctx.config.transcription.modelsDir ?? path.join(ctx.store.dir, "models");
}

function modelFile(ctx: AppContext): string {
  return path.join(modelsDir(ctx), `ggml-${ctx.config.transcription.model}.bin`);
}

/** 使える whisper-cli(見つからなければ null)。一度調べたら覚えておく */
export function whisperCli(ctx: AppContext): string | null {
  const st = stateOf(ctx);
  if (st.cli !== undefined) return st.cli;
  if (ctx.config.transcription.mode === "off") return (st.cli = null);
  try {
    // 起動できて正常に終わること(CPU が対応していない命令で落ちる場合なども「使えない」とする)
    const r = spawnSync(ctx.config.transcription.cli, ["--help"], { stdio: "ignore", timeout: 5000 });
    st.cli = !r.error && r.status === 0 ? ctx.config.transcription.cli : null;
  } catch {
    st.cli = null;
  }
  return st.cli;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

export async function transcriptionStatus(ctx: AppContext): Promise<TranscriptionStatus> {
  const st = stateOf(ctx);
  const cli = whisperCli(ctx);
  const ff = ffmpegPath();
  return {
    available: !!cli && !!ff,
    enabled: ctx.store.settings.transcription.enabled,
    model: ctx.config.transcription.model,
    modelReady: (await exists(modelFile(ctx))) && (await exists(path.join(modelsDir(ctx), VAD_FILE))),
    downloading: st.downloading,
    progress: st.progress,
    queued: st.queued,
    error: st.error,
    reason: !cli
      ? ctx.config.transcription.mode === "off"
        ? "サーバーの設定(TRANSCRIBE=0)で無効になっています"
        : "サーバーに whisper-cli がありません(Docker 版には入っています)"
      : !ff
        ? "サーバーに ffmpeg がありません"
        : null,
  };
}

/** モデルを取得する(なければ)。同時に1つだけ */
async function download(ctx: AppContext, url: string, file: string): Promise<void> {
  const st = stateOf(ctx);
  await mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`モデルを取得できません(HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (d: Buffer) => {
    got += d.length;
    if (total > 0) st.downloading = Math.min(1, got / total);
  });
  await pipeline(body, createWriteStream(part));
  if ((await stat(part)).size < 100_000) {
    await rm(part, { force: true });
    throw new Error("取得したモデルが壊れています");
  }
  await rename(part, file);
}

export function ensureModels(ctx: AppContext): Promise<void> {
  const st = stateOf(ctx);
  if (st.downloadPromise) return st.downloadPromise;
  const run = async () => {
    const model = modelFile(ctx);
    const vad = path.join(modelsDir(ctx), VAD_FILE);
    try {
      if (!(await exists(vad))) {
        st.downloading = 0;
        await download(ctx, ctx.config.transcription.vadUrl, vad);
      }
      if (!(await exists(model))) {
        st.downloading = 0;
        console.log(`[transcribe] 文字起こしのモデル(${ctx.config.transcription.model})を取得しています`);
        await download(ctx, `${ctx.config.transcription.modelBaseUrl}/ggml-${ctx.config.transcription.model}.bin`, model);
        console.log("[transcribe] モデルを取得しました");
      }
      st.error = null;
    } finally {
      st.downloading = null;
      st.downloadPromise = null;
    }
  };
  st.downloadPromise = run();
  return st.downloadPromise;
}

function runChild(bin: string, args: string[], timeoutMs: number, onStderr?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      err = (err + text).slice(-3000);
      if (onStderr) for (const line of text.split(/\r?\n|\r/)) if (line) onStderr(line);
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
      else reject(new Error(`${path.basename(bin)} が失敗しました (code ${code}): ${err.split("\n").slice(-4).join(" ").slice(0, 400)}`));
    });
  });
}

/** whisper-cli の JSON(-oj)を、ミリ秒の区間の一覧にする */
export function parseWhisperJson(json: unknown): TranscriptSegment[] {
  const list = (json as { transcription?: { offsets?: { from?: number; to?: number }; text?: string }[] })?.transcription;
  if (!Array.isArray(list)) throw new Error("文字起こしの結果を読めません");
  const out: TranscriptSegment[] = [];
  for (const x of list) {
    const text = String(x?.text ?? "").trim();
    const from = Number(x?.offsets?.from);
    const to = Number(x?.offsets?.to);
    if (!text || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    // よくある誤認識(無音・雑音から作られる定型文)を除く
    if (/^[(\[(【].*[)\])】]$/.test(text)) continue;
    out.push({ startMs: Math.max(0, Math.round(from)), endMs: Math.max(Math.round(from), Math.round(to)), text });
  }
  return out;
}

async function transcribeOne(ctx: AppContext, iid: string, rid: string): Promise<void> {
  const st = stateOf(ctx);
  const cli = whisperCli(ctx);
  const ff = ffmpegPath();
  const ok = (r: RecordingMeta | undefined): r is RecordingMeta => !!r && r.status === "ready" && !!r.fileName && r.transcript !== "none";
  const iv0 = ctx.store.interviews.get(iid);
  const rec0 = iv0?.recordings.find((r) => r.id === rid);
  if (!iv0 || !ok(rec0)) return;

  const setStatus = (status: RecordingMeta["transcript"], error: string | null = null) =>
    ctx.store.withLock(iid, async () => {
      const iv = ctx.store.interviews.get(iid);
      const rec = iv?.recordings.find((r) => r.id === rid);
      if (!iv || !rec || rec.status !== "ready" || rec.transcript === "none") return false;
      rec.transcript = status;
      rec.transcriptError = error;
      await ctx.store.saveInterview(iv);
      return true;
    });

  if (!cli || !ff) {
    await setStatus("failed", "サーバーで文字起こしを使えません");
    return;
  }
  if (!(await setStatus("running"))) return;
  const work = await mkdtemp(path.join(tmpdir(), "ktb-asr-"));
  try {
    await ensureModels(ctx);
    const video = path.join(ctx.store.recordingDir(iid, rid), rec0.fileName!);
    const wav = path.join(work, "audio.wav");
    const minutes = Math.max(1, (rec0.durationMs ?? 60_000) / 60_000);
    await runChild(ff, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], minutes * 60_000 + 120_000);
    st.progress = { interviewId: iid, recordingId: rid, fraction: 0 };
    const outBase = path.join(work, "out");
    await runChild(
      cli,
      [
        "-m", modelFile(ctx),
        "-f", wav,
        "-l", "ja",
        "-t", String(ctx.config.transcription.threads),
        "--vad", "-vm", path.join(modelsDir(ctx), VAD_FILE),
        "-oj", "-of", outBase,
        "-np", "-pp",
      ],
      // CPU だけでも録画の長さの数倍で終わる。余裕を見て 6 倍 + 10 分で打ち切る
      minutes * 6 * 60_000 + 10 * 60_000,
      (line) => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m && st.progress) st.progress = { ...st.progress, fraction: Number(m[1]) / 100 };
      },
    );
    const segments = parseWhisperJson(JSON.parse(await readFile(`${outBase}.json`, "utf8")));
    const transcript: Transcript = {
      language: "ja",
      model: ctx.config.transcription.model,
      createdAt: new Date().toISOString(),
      segments,
    };
    // 保存は、録画がまだ有効なとき(処理中に削除・保存期間切れ・同意の取り消しがなければ)だけ
    await ctx.store.withLock(iid, async () => {
      const iv = ctx.store.interviews.get(iid);
      const rec = iv?.recordings.find((r) => r.id === rid);
      if (!iv || !rec || rec.status !== "ready" || rec.transcript === "none") return;
      await writeJsonAtomic(path.join(ctx.store.recordingDir(iid, rid), TRANSCRIPT_FILE), transcript);
      rec.transcript = "ready";
      rec.transcriptError = null;
      await ctx.store.saveInterview(iv);
    });
    console.log(`[transcribe] ${iid}/${rid}: 文字起こしを作成しました(${segments.length} 区間)`);
  } catch (e) {
    console.warn(`[transcribe] ${iid}/${rid}: 文字起こしに失敗`, (e as Error).message);
    st.error = (e as Error).message.slice(0, 300);
    await setStatus("failed", /モデル/.test((e as Error).message) ? (e as Error).message.slice(0, 200) : "文字起こしに失敗しました");
  } finally {
    st.progress = null;
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 文字起こしを予約する(使えない・設定で無効・同意がなければ何もしない) */
export async function scheduleTranscription(ctx: AppContext, iid: string, rid: string, force = false): Promise<boolean> {
  if (!ctx.store.settings.transcription.enabled && !force) return false;
  if (!whisperCli(ctx) || !ffmpegPath()) return false;
  const queued = await ctx.store.withLock(iid, async () => {
    const iv = ctx.store.interviews.get(iid);
    const rec = iv?.recordings.find((r) => r.id === rid);
    if (!iv || !rec || rec.status !== "ready" || !rec.fileName) return false;
    if (!iv.consent?.recording || iv.consent.withdrawnScope === "all") return false;
    if (!force && rec.transcript !== "none" && rec.transcript !== undefined) return false;
    if (rec.transcript === "queued" || rec.transcript === "running") return false;
    rec.transcript = "queued";
    rec.transcriptError = null;
    await ctx.store.saveInterview(iv);
    return true;
  });
  if (!queued) return false;
  const st = stateOf(ctx);
  st.queued++;
  const key = `transcribe:${iid}:${rid}`;
  void ctx.jobs.run(key, () => {
    st.queue = st.queue
      .then(() => {
        st.queued = Math.max(0, st.queued - 1);
        return transcribeOne(ctx, iid, rid);
      })
      .catch(() => undefined);
    return st.queue;
  });
  return true;
}

/** 起動時: 途中で止まった文字起こしをやり直す */
export async function resumeTranscriptions(ctx: AppContext): Promise<void> {
  if (!whisperCli(ctx) || !ffmpegPath()) return;
  for (const iv of ctx.store.interviews.values()) {
    for (const rec of iv.recordings) {
      if (rec.status === "ready" && (rec.transcript === "queued" || rec.transcript === "running")) {
        rec.transcript = "none";
        await scheduleTranscription(ctx, iv.id, rec.id, true);
      }
    }
  }
}

export async function readTranscript(ctx: AppContext, iid: string, rid: string): Promise<Transcript | null> {
  try {
    return JSON.parse(await readFile(path.join(ctx.store.recordingDir(iid, rid), TRANSCRIPT_FILE), "utf8")) as Transcript;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
