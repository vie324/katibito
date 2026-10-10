// サーバーの安全性のテスト: 削除・同意の取り消しと送信の競合、保存期間の起点、入力検証の順序、
// 通知リンクの宛先、権限まわりなど(レビューで見つかった問題の再発防止)。

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mulberry32, PROFILES, synthesizeQuestion } from "../scripts/lib/synth";
import { defaultTrackMeta, encodeFaceTrack, FaceTrackBuilder } from "../src/analysis/faceTrack";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import type { Evaluation, InterviewDetail, RecordingMeta } from "../src/shared/types";
import { createApp, requestMeta, type App } from "../server/app";
import { LoginLimiter } from "../server/auth";
import { loadConfig } from "../server/config";
import { runRetention } from "../server/retention";

const SETUP_CODE = "SAFE-TEST";
const DAY = 24 * 3600_000;

let app: App;
let base: string;
let dataDir: string;

type Res = { status: number; json: any };

/** Cookie を保持する簡易クライアント(Host / Origin を指定できるよう node:http で送る) */
class Client {
  cookie = "";

  req(
    method: string,
    p: string,
    body?: unknown,
    opts: { raw?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Res> {
    const payload = opts.raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const headers: Record<string, string> = { "X-Requested-With": "katibito", ...(opts.headers ?? {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    if (payload) {
      headers["Content-Type"] = opts.raw ? "application/octet-stream" : "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const u = new URL(base + p);
      const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const sc = res.headers["set-cookie"]?.[0];
          if (sc) {
            const v = sc.split(";")[0];
            this.cookie = v.endsWith("=") ? "" : v;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          if ((res.headers["content-type"] ?? "").includes("application/json")) json = JSON.parse(text);
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  /** 本文を半分だけ送って止めておく(送信中に別の操作を割り込ませるため) */
  startUpload(p: string, data: Buffer, headers: Record<string, string> = {}): { finish: () => Promise<Res> } {
    const u = new URL(base + p);
    const req = http.request({
      method: "PUT",
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: {
        ...headers,
        "X-Requested-With": "katibito",
        Cookie: this.cookie,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
      },
    });
    const done = new Promise<Res>((resolve, reject) => {
      req.on("response", (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
    });
    const half = Math.floor(data.length / 2);
    req.write(data.subarray(0, half));
    return {
      finish: async () => {
        req.end(data.subarray(half));
        return done;
      },
    };
  }
}

const fromDevice = (clientId: string): Record<string, string> => ({ "X-Recording-Client-Id": clientId });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WEBM = () => readFileSync(path.join(__dirname, "fixtures", "chrome-recording.webm"));

function trackGz(): Buffer {
  const rng = mulberry32(7);
  const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
  const sq = synthesizeQuestion(PROFILES.balanced, 0, 60_000, rng);
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

const admin = new Client();
const alice = new Client();
const bob = new Client();
let aliceId = "";
let bobId = "";

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "ktb-safe-"));
  const config = { ...loadConfig({}), dataDir, staticDir: null, setupCode: SETUP_CODE };
  app = await createApp(config, { log: false });
  const addr = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${addr.port}`;

  expect(
    (await admin.req("POST", "/api/setup", { setupCode: SETUP_CODE, orgName: "テスト", loginId: "boss", name: "代表", password: "password-123" }))
      .status,
  ).toBe(200);
  for (const [c, loginId] of [
    [alice, "alice"],
    [bob, "bob"],
  ] as const) {
    const u = await admin.req("POST", "/api/users", { loginId, name: loginId, role: "interviewer", password: "password-123" });
    expect(u.status).toBe(200);
    if (loginId === "alice") aliceId = u.json.user.id;
    else bobId = u.json.user.id;
    expect((await c.req("POST", "/api/login", { loginId, password: "password-123" })).status).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 同意を記録した面接を作る */
async function newInterview(opts: { analysis?: boolean } = {}): Promise<string> {
  const r = await alice.req("POST", "/api/interviews", { candidate: { displayName: "テスト" }, interviewerIds: [aliceId, bobId] });
  const iid = r.json.interview.id as string;
  const c = await alice.req("POST", `/api/interviews/${iid}/consent`, {
    recording: true,
    analysis: opts.analysis ?? true,
    candidateName: "テスト",
    method: "paper",
    consentText: "紙の同意書で取得(本文は別紙)",
  });
  expect(c.status).toBe(200);
  return iid;
}

/** 録画を作って送り終え、再生できるまで待つ */
async function readyRecording(iid: string, clientId: string, opts: { startedAt?: string } = {}): Promise<RecordingMeta> {
  const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, {
    clientId,
    source: "live",
    mimeType: "video/webm;codecs=vp8,opus",
    startedAt: opts.startedAt ?? new Date().toISOString(),
  });
  const rid = r.json.recording.id as string;
  expect((await alice.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice(clientId) })).status).toBe(200);
  const done = await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice(clientId) });
  expect(done.status).toBe(200);
  await app.ctx.jobs.idle();
  const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
  const rec = d.interview.recordings.find((x) => x.id === rid)!;
  expect(rec.status).toBe("ready");
  return rec;
}

describe("削除・同意の取り消しと送信の競合", () => {
  it("顔トラックの受信中に計測への同意が取り消されたら、保存しない", async () => {
    const iid = await newInterview();
    const rec = await readyRecording(iid, "dev-track-race");
    const up = alice.startUpload(`/api/interviews/${iid}/recordings/${rec.id}/track`, trackGz(), fromDevice("dev-track-race"));
    await sleep(150);
    expect((await admin.req("POST", `/api/interviews/${iid}/consent/withdraw`, { scope: "analysis" })).status).toBe(200);
    const res = await up.finish();
    expect(res.status).toBe(403);

    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings[0].analysis).toBe("none");
    expect((await alice.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/summary`)).status).toBe(404);
    const dir = path.join(dataDir, "interviews", iid, "recordings", rec.id);
    expect(existsSync(path.join(dir, "track.bin.gz"))).toBe(false);
    expect(existsSync(path.join(dir, "summary.json"))).toBe(false);
  });

  it("すべての取り消しのあとに届いた顔トラックで、消したディレクトリを作り直さない", async () => {
    const iid = await newInterview();
    const rec = await readyRecording(iid, "dev-track-race-2");
    const up = alice.startUpload(`/api/interviews/${iid}/recordings/${rec.id}/track`, trackGz(), fromDevice("dev-track-race-2"));
    await sleep(150);
    expect((await admin.req("POST", `/api/interviews/${iid}/consent/withdraw`, { scope: "all" })).status).toBe(200);
    expect((await up.finish()).status).toBe(403);
    expect(existsSync(path.join(dataDir, "interviews", iid, "recordings", rec.id))).toBe(false);
    const cmp = await bob.req("GET", "/api/compare");
    expect(cmp.json.rows.find((x: { id: string }) => x.id === iid).expression).toBeNull();
  });

  it("チャンクの受信中に面接が削除されたら、ディレクトリを作り直さない", async () => {
    const iid = await newInterview();
    const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-chunk-race", source: "live", mimeType: "video/webm" });
    const rid = r.json.recording.id;
    const up = alice.startUpload(`/api/interviews/${iid}/recordings/${rid}/chunks/0`, WEBM(), fromDevice("dev-chunk-race"));
    await sleep(150);
    expect((await admin.req("DELETE", `/api/interviews/${iid}`)).status).toBe(200);
    expect((await up.finish()).status).toBe(409);
    expect(existsSync(path.join(dataDir, "interviews", iid))).toBe(false);
  });

  it("録画の仕上げ中は、同意の取り消し・面接の削除を受け付けない", async () => {
    const iid = await newInterview();
    const rec = await readyRecording(iid, "dev-finalize");
    let release!: () => void;
    void app.ctx.jobs.run(`finalize:${iid}:${rec.id}`, () => new Promise<void>((r) => (release = r)));
    try {
      expect((await admin.req("POST", `/api/interviews/${iid}/consent/withdraw`, { scope: "all" })).status).toBe(409);
      expect((await admin.req("DELETE", `/api/interviews/${iid}`)).status).toBe(409);
    } finally {
      release();
      await app.ctx.jobs.idle();
    }
    expect((await admin.req("POST", `/api/interviews/${iid}/consent/withdraw`, { scope: "all" })).status).toBe(200);
  });
});

describe("録画の送信と処理", () => {
  it("取り込んだ動画の撮影日が古くても、保存期間はサーバーが受け取った日から数える", async () => {
    const iid = await newInterview();
    const old = new Date(Date.now() - 200 * DAY).toISOString();
    const rec = await readyRecording(iid, "dev-old-file", { startedAt: old });
    await runRetention(app.ctx, Date.now());
    let d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings.find((x) => x.id === rec.id)!.status).toBe("ready");
    // 受け取ってから「未判定の保存日数」(既定 180日)を過ぎれば消える
    await runRetention(app.ctx, Date.now() + 181 * DAY);
    d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings.find((x) => x.id === rec.id)!.status).toBe("purged");
  });

  it("仕上げに失敗した録画は、受信済みのデータから管理者が再処理できる", async () => {
    const iid = await newInterview();
    const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-reprocess", source: "live", mimeType: "video/webm;codecs=vp8,opus" });
    const rid = r.json.recording.id as string;
    await alice.req("PUT", `/api/interviews/${iid}/recordings/${rid}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice("dev-reprocess") });
    // 仕上げに失敗した状態(受信したチャンクは残る)を作る
    const stored = app.ctx.store.interviews.get(iid)!.recordings.find((x) => x.id === rid)!;
    stored.status = "failed";
    stored.chunkCount = 1;
    stored.error = "録画の仕上げに失敗しました";

    expect((await alice.req("POST", `/api/interviews/${iid}/recordings/${rid}/reprocess`, {})).status).toBe(403);
    const re = await admin.req("POST", `/api/interviews/${iid}/recordings/${rid}/reprocess`, {});
    expect(re.status).toBe(200);
    expect(re.json.recording.status).toBe("processing");
    await app.ctx.jobs.idle();
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    const rec = d.interview.recordings.find((x) => x.id === rid)!;
    expect(rec.status).toBe("ready");
    expect(rec.error).toBeNull();
    // 再生できる録画はもう再処理できない
    expect((await admin.req("POST", `/api/interviews/${iid}/recordings/${rid}/reprocess`, {})).status).toBe(409);
  });

  it("削除・取り消しした録画は、録画の数の上限に数えない", async () => {
    const iid = await newInterview({ analysis: false });
    for (let i = 0; i < 20; i++) {
      const r = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: `dev-limit-${i}`, source: "file", mimeType: "video/mp4" });
      expect(r.status).toBe(200);
      const ab = await alice.req("POST", `/api/interviews/${iid}/recordings/${r.json.recording.id}/abort`, {}, { headers: fromDevice(`dev-limit-${i}`) });
      expect(ab.status).toBe(200);
    }
    const next = await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-limit-x", source: "file", mimeType: "video/mp4" });
    expect(next.status).toBe(200);
  });
});

describe("入力の検証と権限", () => {
  it("面接の編集で入力エラーがあれば、何も変わらない", async () => {
    const iid = await newInterview();
    const bad = await alice.req("PATCH", `/api/interviews/${iid}`, { candidate: { displayName: "別の名前" }, scheduledAt: "bad" });
    expect(bad.status).toBe(400);
    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.candidate.displayName).toBe("テスト");
  });

  it("ユーザーの変更で入力エラーがあれば、何も変わらない(無効化もされない)", async () => {
    const bad = await admin.req("PATCH", `/api/users/${bobId}`, { disabled: true, password: "short" });
    expect(bad.status).toBe(400);
    const users = (await admin.req("GET", "/api/users")).json.users as { id: string; disabled: boolean }[];
    expect(users.find((u) => u.id === bobId)!.disabled).toBe(false);
    expect((await bob.req("GET", "/api/session")).json.user?.loginId).toBe("bob");
  });

  it("同じログインIDのユーザーを同時に作っても、1人しか作られない", async () => {
    const body = { loginId: "twin", name: "双子", role: "interviewer", password: "password-123" };
    const [a, b] = await Promise.all([admin.req("POST", "/api/users", body), admin.req("POST", "/api/users", body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const users = (await admin.req("GET", "/api/users")).json.users as { loginId: string }[];
    expect(users.filter((u) => u.loginId === "twin")).toHaveLength(1);
  });

  it("18歳未満は、未成年のチェックがなくても保護者の同意が必要", async () => {
    const r = await alice.req("POST", "/api/interviews", { candidate: { displayName: "十五歳", age: 15, minor: false } });
    expect(r.json.interview.candidate.minor).toBe(true);
    const iid = r.json.interview.id;
    const consent = { recording: true, analysis: true, candidateName: "十五歳", method: "onscreen", consentText: "面接の録画と表情の計測についてのお願い(本文)" };
    expect((await alice.req("POST", `/api/interviews/${iid}/consent`, consent)).status).toBe(400);
    expect((await alice.req("POST", `/api/interviews/${iid}/consent`, { ...consent, guardianName: "保護者" })).status).toBe(200);
  });

  it("通知先URLは管理者にだけ返す", async () => {
    const s = (await admin.req("GET", "/api/settings")).json.settings;
    const put = await admin.req("PUT", "/api/settings", { ...s, webhookUrl: "https://hooks.example.invalid/abc" });
    expect(put.status).toBe(200);
    expect((await admin.req("GET", "/api/settings")).json.settings.webhookUrl).toBe("https://hooks.example.invalid/abc");
    expect((await alice.req("GET", "/api/settings")).json.settings.webhookUrl).toBeNull();
    expect((await admin.req("PUT", "/api/settings", { ...s, webhookUrl: null })).status).toBe(200);
  });

  it("通知のリンク先は、Host ヘッダを書き換えたリクエストでは変わらない", async () => {
    app.ctx.lastOrigin = null;
    const anon = new Client();
    await anon.req("GET", "/api/health", undefined, { headers: { Host: "evil.example.com" } });
    await anon.req("POST", "/api/login", { loginId: "nobody", password: "x" }, { headers: { Host: "evil.example.com", Origin: "http://evil.example.com" } });
    expect(app.ctx.lastOrigin).toBeNull();
    // ログインした利用者のブラウザからの送信(Origin が一致)だけを使う
    const origin = base;
    await alice.req("POST", "/api/interviews", { candidate: { displayName: "リンク" } }, { headers: { Origin: origin } });
    expect(app.ctx.lastOrigin).toBe(origin);
  });

  it("ログインの失敗は、接続元を変えても1つのログインIDにつき上限がある", () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 30; i++) limiter.fail(`10.0.0.${i}`, "Boss");
    expect(limiter.blocked("10.0.1.1", "boss")).toBe(true);
    expect(limiter.blocked("10.0.1.1", "alice")).toBe(false);
  });

  it("X-Forwarded-For は末尾(直前のプロキシが見た接続元)を使う", () => {
    const req = { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.7", "x-forwarded-proto": "https", host: "a.example" }, socket: { remoteAddress: "172.18.0.2" } };
    expect(requestMeta(req as never, true)).toEqual({ secure: true, origin: "https://a.example", ip: "10.0.0.7" });
    expect(requestMeta(req as never, false).ip).toBe("172.18.0.2");
  });
});

describe("評価の非公開ルール", () => {
  it("提出後の修正は回数・日時と「ほかの評価が見える状態での修正」が残り、ほかの評価者にも見える", async () => {
    const iid = await newInterview();
    const ratings = { manner: 4, response: 3, motivation: 5, cooperation: 4, expression: 3 };
    const a1 = await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "pass", comment: "", submit: true });
    expect(a1.status).toBe(200);
    const firstAt = (a1.json as InterviewDetail).evaluations.mine!.submittedAt;
    expect((a1.json as InterviewDetail).evaluations.mine!.revisions ?? 0).toBe(0);

    await bob.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "fail", comment: "", submit: true });
    // 同じ内容での再提出は修正に数えない
    const same = await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "pass", comment: "", submit: true });
    expect((same.json as InterviewDetail).evaluations.mine!.revisions ?? 0).toBe(0);
    // ほかの評価が見える状態で票を変える
    await sleep(5);
    const changed = await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "fail", comment: "", submit: true });
    const mine = (changed.json as InterviewDetail).evaluations.mine as Evaluation;
    expect(mine.revisions).toBe(1);
    expect(mine.revisedWhileOthersVisible).toBe(true);
    expect(mine.submittedAt).toBe(firstAt);
    expect(mine.revisedAt).not.toBeNull();

    const bobView = (await bob.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    const aliceEval = bobView.evaluations.others!.find((e) => e.userId === aliceId)!;
    expect(aliceEval.revisions).toBe(1);
    expect(aliceEval.revisedWhileOthersVisible).toBe(true);
    const log = (await admin.req("GET", "/api/audit")).json.entries as { action: string }[];
    expect(log.some((e) => e.action === "evaluation_revise")).toBe(true);
  });
});
