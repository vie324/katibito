// 文字起こし(whisper.cpp)のテスト。
// 実際の whisper-cli を使う結合テストは、次の環境変数がある場合だけ実行する:
//   WHISPER_CLI=<whisper-cli のパス> WHISPER_MODELS_DIR=<ggml-small-q5_1.bin と ggml-silero-v5.1.2.bin のある場所>
//   TRANSCRIBE_TEST_AUDIO=<日本語の音声ファイル> TRANSCRIBE_TEST_EXPECT=<含まれるはずの語>

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InterviewDetail, Transcript } from "../src/shared/types";
import { loadConfig } from "../server/config";
import { parseWhisperJson } from "../server/transcribe";
import { fromDevice, newInterview, setupTeam, sleep, startServer, type Client, type TestServer } from "./helpers/http";

describe("whisper-cli の結果の読み取り", () => {
  it("区間の時刻(ms)と文字を取り出し、空の区間と(音楽)などの注記は除く", () => {
    const segs = parseWhisperJson({
      transcription: [
        { offsets: { from: 3000, to: 5200 }, text: " 水をマレーシアから買わなくてはならないのです" },
        { offsets: { from: 6000, to: 7000 }, text: " " },
        { offsets: { from: 8000, to: 9000 }, text: "(音楽)" },
        { offsets: { from: 9000, to: 9500 }, text: "[BLANK_AUDIO]" },
        { offsets: { from: 10_000, to: 12_500 }, text: "はい、ありがとうございます。" },
      ],
    });
    expect(segs).toEqual([
      { startMs: 3000, endMs: 5200, text: "水をマレーシアから買わなくてはならないのです" },
      { startMs: 10_000, endMs: 12_500, text: "はい、ありがとうございます。" },
    ]);
  });

  it("形式が違えばエラー", () => {
    expect(() => parseWhisperJson({ nope: true })).toThrow();
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CLI = process.env.WHISPER_CLI;
const MODELS = process.env.WHISPER_MODELS_DIR;
const AUDIO = process.env.TRANSCRIBE_TEST_AUDIO;
const EXPECT = process.env.TRANSCRIBE_TEST_EXPECT ?? "";

describe.runIf(!!CLI && !!MODELS && !!AUDIO && hasFfmpeg())("文字起こし(実際の whisper.cpp)", () => {
  let server: TestServer;
  let alice: Client;
  let admin: Client;
  let work: string;

  beforeAll(async () => {
    const base = loadConfig({});
    server = await startServer({
      transcription: { ...base.transcription, mode: "auto", cli: CLI!, modelsDir: MODELS!, model: process.env.WHISPER_MODEL || "small-q5_1" },
    });
    ({ alice, admin } = await setupTeam(server));
    work = mkdtempSync(path.join(tmpdir(), "ktb-asr-test-"));
  });

  afterAll(async () => {
    await server.close();
    rmSync(work, { recursive: true, force: true });
  });

  it("録画が再生できるようになると文字起こしが作られ、録画の時刻と合っている(無音の区間を飛ばす)", async () => {
    // 3秒の無音のあとに話す録画(WebM: VP8 + Opus)
    const webm = path.join(work, "speech.webm");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=15",
      "-i", AUDIO!,
      "-filter_complex", "[1:a]adelay=3000|3000,apad=pad_dur=3[a]",
      "-map", "0:v", "-map", "[a]", "-shortest",
      "-c:v", "libvpx", "-b:v", "150k", "-c:a", "libopus", "-ar", "48000",
      webm,
    ]);
    const iid = await newInterview(alice, { candidate: { displayName: "文字起こしの人" } });
    const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-asr-1", source: "file", mimeType: "video/webm;codecs=vp8,opus" });
    const rid = r.json.recording.id as string;
    await alice.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: readFileSync(webm), headers: fromDevice("dev-asr-1") });
    await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/complete`, { chunkCount: 1 }, { headers: fromDevice("dev-asr-1") });

    let status = "";
    for (let i = 0; i < 240; i++) {
      await server.app.ctx.jobs.idle();
      const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
      status = d.interview.recordings[0].transcript;
      if (status === "ready" || status === "failed") break;
      await sleep(500);
    }
    expect(status).toBe("ready");
    const t = (await alice.req("GET", `/api/interviews/${iid}/recordings/${rid}/transcript`)).json.transcript as Transcript;
    expect(t.segments.length).toBeGreaterThan(0);
    const all = t.segments.map((s) => s.text).join("");
    if (EXPECT) expect(all).toContain(EXPECT);
    // 話し始め(3秒)と区間の開始がおおむね合っている
    expect(t.segments[0].startMs).toBeGreaterThan(2000);
    expect(t.segments[0].startMs).toBeLessThan(4500);

    // 管理者はやり直せる。面接官はできない
    expect((await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/transcript`, {})).status).toBe(403);
    const again = await admin.req("POST", `/api/interviews/${iid}/recordings/${rid}/transcript`, {});
    expect(again.status).toBe(200);
    expect(["queued", "running"]).toContain(again.json.recording.transcript);
    await server.app.ctx.jobs.idle();

    // 同意をすべて取り消すと、文字起こしも消える
    const w = await admin.req("POST", `/api/interviews/${iid}/consent/withdraw`, { scope: "all" });
    expect(w.status).toBe(200);
    expect((await alice.req("GET", `/api/interviews/${iid}/recordings/${rid}/transcript`)).status).toBe(404);
  }, 300_000);
});
