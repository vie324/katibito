// サーバーの結合テスト用の小さな道具: 一時ディレクトリでサーバーを起動し、Cookie を保持するクライアントで叩く。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { mulberry32, PROFILES, synthesizeQuestion } from "../../scripts/lib/synth";
import { defaultTrackMeta, encodeFaceTrack, FaceTrackBuilder } from "../../src/analysis/faceTrack";
import { BLEND_COUNT } from "../../src/engine/blendshapeNames";
import { createApp, type App } from "../../server/app";
import { loadConfig, type Config } from "../../server/config";

export type Res = { status: number; json: any; headers: http.IncomingHttpHeaders; buf: Buffer };

export type TestServer = { app: App; base: string; dataDir: string; close: () => Promise<void> };

export async function startServer(overrides: Partial<Config> = {}, setupCode = "TEST-CODE"): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ktb-test-"));
  const config = { ...loadConfig({}), dataDir, staticDir: null, setupCode, ...overrides };
  const app = await createApp(config, { log: false });
  const addr = await app.listen(0, "127.0.0.1");
  return {
    app,
    base: `http://127.0.0.1:${addr.port}`,
    dataDir,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Cookie を保持する簡易クライアント(Host / Origin などのヘッダを自由に付けられるよう node:http で送る) */
export class Client {
  cookie = "";

  constructor(private readonly base: () => string) {}

  req(method: string, p: string, body?: unknown, opts: { raw?: Buffer; headers?: Record<string, string>; contentType?: string } = {}): Promise<Res> {
    const payload = opts.raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const headers: Record<string, string> = { "X-Requested-With": "katibito", ...(opts.headers ?? {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    if (payload) {
      headers["Content-Type"] = opts.contentType ?? (opts.raw ? "application/octet-stream" : "application/json");
      headers["Content-Length"] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const u = new URL(this.base() + p);
      const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const sc = res.headers["set-cookie"]?.[0];
          if (sc) {
            const v = sc.split(";")[0];
            this.cookie = v.endsWith("=") ? "" : v;
          }
          const buf = Buffer.concat(chunks);
          let json: any = null;
          if ((res.headers["content-type"] ?? "").includes("application/json")) json = JSON.parse(buf.toString("utf8"));
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers, buf });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  async login(loginId: string, password: string): Promise<Res> {
    return this.req("POST", "/api/login", { loginId, password });
  }
}

export const fromDevice = (clientId: string): Record<string, string> => ({ "X-Recording-Client-Id": clientId });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const WEBM = () => readFileSync(path.join(__dirname, "..", "fixtures", "chrome-recording.webm"));

/** 合成の顔トラック(gzip)。秒数ぶん、質問1つ分の表情の動きを作る */
export function trackGz(seconds = 60, seed = 7): Buffer {
  const rng = mulberry32(seed);
  const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
  const sq = synthesizeQuestion(PROFILES.balanced, 0, seconds * 1000, rng);
  for (let i = 0; i < sq.frames.count; i += 2) {
    b.push(sq.frames.t[i], 1, {
      blend: sq.frames.blend.subarray(i * BLEND_COUNT, (i + 1) * BLEND_COUNT),
      yaw: sq.frames.yaw[i],
      pitch: sq.frames.pitch[i],
      roll: sq.frames.roll[i],
      box: { x0: 0.4, y0: 0.3, x1: 0.52, y1: 0.52 },
    });
  }
  return gzipSync(Buffer.from(encodeFaceTrack(b.build())));
}

/** 管理者(boss)と面接官(alice, bob)を用意してログインしたクライアントを返す */
export async function setupTeam(server: TestServer, setupCode = "TEST-CODE") {
  const base = () => server.base;
  const admin = new Client(base);
  const alice = new Client(base);
  const bob = new Client(base);
  const s = await admin.req("POST", "/api/setup", { setupCode, orgName: "テスト塾", loginId: "boss", name: "代表", password: "password-123" });
  if (s.status !== 200) throw new Error(`setup failed: ${JSON.stringify(s.json)}`);
  const ids: Record<string, string> = { boss: s.json.user.id };
  for (const [c, loginId, name] of [
    [alice, "alice", "面接官A"],
    [bob, "bob", "面接官B"],
  ] as const) {
    const u = await admin.req("POST", "/api/users", { loginId, name, role: "interviewer", password: "password-123" });
    if (u.status !== 200) throw new Error(`user create failed: ${JSON.stringify(u.json)}`);
    ids[loginId] = u.json.user.id;
    const l = await c.login(loginId, "password-123");
    if (l.status !== 200) throw new Error(`login failed: ${JSON.stringify(l.json)}`);
  }
  return { admin, alice, bob, ids };
}

/** 同意を記録した面接を作る */
export async function newInterview(c: Client, body: Record<string, unknown> = {}, consent: { analysis?: boolean } = {}): Promise<string> {
  const r = await c.req("POST", "/api/interviews", { candidate: { displayName: "テスト" }, ...body });
  if (r.status !== 200) throw new Error(`interview create failed: ${JSON.stringify(r.json)}`);
  const iid = r.json.interview.id as string;
  const cand = r.json.interview.candidate as { age: number | null; minor: boolean };
  const cr = await c.req("POST", `/api/interviews/${iid}/consent`, {
    recording: true,
    analysis: consent.analysis ?? true,
    candidateName: "テスト",
    // 未成年は保護者の同意が必要
    ...(cand.minor || (cand.age !== null && cand.age < 18) ? { guardianName: "テスト 保護者", guardianRelation: "母" } : {}),
    method: "paper",
    consentText: "紙の同意書で取得(本文は別紙)",
  });
  if (cr.status !== 200) throw new Error(`consent failed: ${JSON.stringify(cr.json)}`);
  return iid;
}

/** 録画を送り終えて、再生できるまで待つ */
export async function readyRecording(server: TestServer, c: Client, iid: string, clientId: string): Promise<string> {
  const r = await c.req("POST", `/api/interviews/${iid}/recordings`, { clientId, source: "live", mimeType: "video/webm;codecs=vp8,opus" });
  const rid = r.json.recording.id as string;
  const put = await c.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice(clientId) });
  if (put.status !== 200) throw new Error(`chunk failed: ${JSON.stringify(put.json)}`);
  const done = await c.req("POST", `/api/interviews/${iid}/recordings/${rid}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice(clientId) });
  if (done.status !== 200) throw new Error(`complete failed: ${JSON.stringify(done.json)}`);
  await server.app.ctx.jobs.idle();
  return rid;
}

export const RATINGS = { manner: 4, response: 3, motivation: 5, cooperation: 4, expression: 3 };
