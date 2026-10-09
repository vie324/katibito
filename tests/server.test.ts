// サーバー API の結合テスト。実際に HTTP で起動し、運用の流れを一通り通す。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mulberry32, PROFILES, synthesizeQuestion } from "../scripts/lib/synth";
import { defaultTrackMeta, encodeFaceTrack, FaceTrackBuilder } from "../src/analysis/faceTrack";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import type { InterviewDetail, InterviewListItem, RecordingMeta, SessionInfo } from "../src/shared/types";
import { createApp, type App } from "../server/app";
import { loadConfig } from "../server/config";
import { runRetention } from "../server/retention";

const SETUP_CODE = "TEST-CODE";

/** 録画した端末だけが持つ録画ID(送信の合言葉) */
const fromDevice = (clientId: string): Record<string, string> => ({ "X-Recording-Client-Id": clientId });

/** Cookie を保持するだけの簡易クライアント。接続先は常に現在の base(再起動テストで変わる) */
class Client {
  cookie = "";

  async req(
    method: string,
    p: string,
    body?: unknown,
    opts: { raw?: Buffer; contentType?: string; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<{ status: number; json: any; headers: Headers; buf: Buffer }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.csrf !== false) headers["X-Requested-With"] = "katibito";
    if (this.cookie) headers.Cookie = this.cookie;
    let payload: BodyInit | undefined;
    if (opts.raw) {
      payload = new Uint8Array(opts.raw);
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(base + p, { method, headers, body: payload });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const v = setCookie.split(";")[0];
      this.cookie = v.endsWith("=") ? "" : v;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) json = JSON.parse(buf.toString("utf8"));
    return { status: res.status, json, headers: res.headers, buf };
  }
}

function syntheticTrackGz(): Buffer {
  const rng = mulberry32(42);
  const b = new FaceTrackBuilder(defaultTrackMeta({ source: "live", intervalMs: 66 }));
  let t0 = 0;
  for (let q = 0; q < 3; q++) {
    const sq = synthesizeQuestion(PROFILES.balanced, t0, 60_000, rng);
    for (let i = 0; i < sq.frames.count; i += 2) {
      b.push(sq.frames.t[i], 1, {
        blend: sq.frames.blend.subarray(i * BLEND_COUNT, (i + 1) * BLEND_COUNT),
        yaw: sq.frames.yaw[i],
        pitch: sq.frames.pitch[i],
        roll: sq.frames.roll[i],
        box: { x0: 0.4, y0: 0.3, x1: 0.52, y1: 0.52 },
      });
    }
    t0 += 60_000;
  }
  return gzipSync(Buffer.from(encodeFaceTrack(b.build())));
}

let app: App;
let base: string;
let dataDir: string;
let staticDir: string;
const admin = () => new Client();

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "ktb-data-"));
  staticDir = mkdtempSync(path.join(tmpdir(), "ktb-static-"));
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  mkdirSync(path.join(staticDir, "assets"));
  writeFileSync(path.join(staticDir, "assets", "app-abc.js"), "console.log(1)");
  const config = { ...loadConfig({}), dataDir, staticDir, setupCode: SETUP_CODE };
  app = await createApp(config, { log: false });
  const addr = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(staticDir, { recursive: true, force: true });
});

describe("運用の流れ(API)", () => {
  const A = admin();
  const alice = admin();
  const bob = admin();
  let aliceId = "";
  let bobId = "";
  let iid = "";
  let rec: RecordingMeta;

  it("初期設定: コードが必要。CSRF ヘッダがないと拒否", async () => {
    const s0 = await A.req("GET", "/api/session");
    expect((s0.json as SessionInfo).needsSetup).toBe(true);

    const body = { setupCode: SETUP_CODE, orgName: "テスト塾", loginId: "boss", name: "代表", password: "password-123" };
    expect((await A.req("POST", "/api/setup", body, { csrf: false })).status).toBe(403);
    expect((await A.req("POST", "/api/setup", { ...body, setupCode: "WRONG-CODE" })).status).toBe(403);
    const ok = await A.req("POST", "/api/setup", body);
    expect(ok.status).toBe(200);
    expect(ok.json.user.role).toBe("admin");
    expect(A.cookie).toContain("ktb_session=");
    expect((await A.req("POST", "/api/setup", body)).status).toBe(409);

    const s1 = await A.req("GET", "/api/session");
    expect(s1.json.user.loginId).toBe("boss");
    expect(s1.json.orgName).toBe("テスト塾");
  });

  it("ログイン・ログアウト・失敗の制限", async () => {
    const c = admin();
    expect((await c.req("POST", "/api/login", { loginId: "boss", password: "nope-nope" })).status).toBe(401);
    expect((await c.req("POST", "/api/login", { loginId: "boss", password: "password-123" })).status).toBe(200);
    expect((await c.req("GET", "/api/interviews")).status).toBe(200);
    await c.req("POST", "/api/logout", {});
    expect((await c.req("GET", "/api/interviews")).status).toBe(401);
    for (let i = 0; i < 8; i++) await c.req("POST", "/api/login", { loginId: "ghost", password: "x".repeat(8) });
    expect((await c.req("POST", "/api/login", { loginId: "ghost", password: "x".repeat(8) })).status).toBe(429);
  });

  it("ユーザー管理は管理者のみ", async () => {
    const ra = await A.req("POST", "/api/users", { loginId: "alice", name: "面接官A", role: "interviewer", password: "alice-pass-1" });
    expect(ra.status).toBe(200);
    aliceId = ra.json.user.id;
    const rb = await A.req("POST", "/api/users", { loginId: "bob", name: "面接官B", role: "interviewer", password: "bob-pass-12" });
    bobId = rb.json.user.id;
    expect((await A.req("POST", "/api/users", { loginId: "alice", name: "x", role: "interviewer", password: "abcdefgh" })).status).toBe(409);
    expect((await A.req("POST", "/api/users", { loginId: "short", name: "x", role: "interviewer", password: "1" })).status).toBe(400);

    expect((await alice.req("POST", "/api/login", { loginId: "alice", password: "alice-pass-1" })).status).toBe(200);
    expect((await bob.req("POST", "/api/login", { loginId: "bob", password: "bob-pass-12" })).status).toBe(200);
    expect((await alice.req("POST", "/api/users", { loginId: "eve", name: "x", role: "admin", password: "abcdefgh" })).status).toBe(403);
    // 最後の管理者は降格できない
    const me = (await A.req("GET", "/api/session")).json.user.id;
    expect((await A.req("PATCH", `/api/users/${me}`, { role: "interviewer" })).status).toBe(409);
  });

  it("面接の登録と同意の記録(未成年は保護者が必要)", async () => {
    const r = await alice.req("POST", "/api/interviews", {
      candidate: { displayName: "山田 花子", kana: "やまだ はなこ", age: 15 },
      scheduledAt: "2026-10-20T10:00:00+09:00",
      location: "本部 面接室",
      interviewerIds: [aliceId, bobId],
    });
    expect(r.status).toBe(200);
    const d = r.json as InterviewDetail;
    iid = d.interview.id;
    expect(d.interview.candidate.minor).toBe(true);
    expect(d.interview.questions.length).toBeGreaterThan(0);
    expect(d.status).toBe("scheduled");

    // 同意前は録画を作れない
    const pre = await alice.req("POST", `/api/interviews/${iid}/recordings`, {
      clientId: "local-000001", source: "live", mimeType: "video/webm;codecs=vp8,opus", startedAt: new Date().toISOString(),
    });
    expect(pre.status).toBe(403);

    const consent = {
      recording: true, analysis: true, candidateName: "山田 花子", guardianName: "", method: "onscreen",
      consentText: "面接の録画と表情の計測についてのお願い……(本文)",
    };
    expect((await alice.req("POST", `/api/interviews/${iid}/consent`, consent)).status).toBe(400);
    const ok = await alice.req("POST", `/api/interviews/${iid}/consent`, { ...consent, guardianName: "山田 太郎", guardianRelation: "父" });
    expect(ok.status).toBe(200);
    expect(ok.json.interview.consent.consentVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(ok.json.interview.consent.obtainedByName).toBe("面接官A");
  });

  it("録画: 分割送信(再開可能)→ 完了 → 結合と索引付け → Range 配信", async () => {
    const create = () =>
      alice.req("POST", `/api/interviews/${iid}/recordings`, {
        clientId: "local-000001", source: "live", mimeType: "video/webm;codecs=vp8,opus", startedAt: new Date().toISOString(),
      });
    const r1 = await create();
    expect(r1.status).toBe(200);
    rec = r1.json.recording;
    expect(rec.clientId).toBe(""); // 合言葉は応答に含めない
    expect((await create()).json.recording.id).toBe(rec.id); // 冪等

    const webm = readFileSync(path.join(__dirname, "fixtures", "chrome-recording.webm"));
    const parts = [webm.subarray(0, 20_000), webm.subarray(20_000, 50_000), webm.subarray(50_000)];
    const put = (i: number, who = alice, headers = fromDevice("local-000001")) =>
      who.req("PUT", `/api/interviews/${iid}/recordings/${rec.id}/chunks/${i}`, undefined, { raw: Buffer.from(parts[i]), headers });
    // 録画した端末の録画IDがないと送れない(ほかの面接官が上書きできない)
    expect((await put(0, alice, {})).status).toBe(403);
    expect((await put(0, bob, fromDevice("local-999999"))).status).toBe(403);
    expect((await put(0)).status).toBe(200);
    expect((await put(2)).status).toBe(200);
    // 1 が抜けている
    const early = await alice.req(
      "POST",
      `/api/interviews/${iid}/recordings/${rec.id}/complete`,
      { chunkCount: 3, durationMs: 4000 },
      { headers: fromDevice("local-000001") },
    );
    expect(early.status).toBe(409);
    // 別の人が途中で完了させることはできない
    expect((await bob.req("POST", `/api/interviews/${iid}/recordings/${rec.id}/complete`, { chunkCount: 1 })).status).toBe(403);
    const st = await alice.req("GET", `/api/interviews/${iid}/recordings/${rec.id}`);
    expect(st.json.received).toEqual([0, 2]);
    expect((await put(1)).status).toBe(200);
    expect((await put(1)).status).toBe(200); // 再送しても問題ない

    const done = await alice.req(
      "POST",
      `/api/interviews/${iid}/recordings/${rec.id}/complete`,
      {
        chunkCount: 3,
        durationMs: 4100,
        markers: [
          { tMs: 0, kind: "question", label: "自己紹介" },
          { tMs: 60_000, kind: "question", label: "志望理由" },
          { tMs: 90_000, kind: "bookmark", label: "★" },
        ],
      },
      { headers: fromDevice("local-000001") },
    );
    expect(done.status).toBe(200);
    expect(["processing", "ready"]).toContain(done.json.recording.status);
    await app.ctx.jobs.idle();

    const d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    const ready = d.interview.recordings.find((x) => x.id === rec.id)!;
    expect(ready.status).toBe("ready");
    expect(ready.indexed).toBe(true);
    expect(ready.durationMs).toBeGreaterThan(3000);
    expect(ready.markers).toHaveLength(3);
    expect(ready.clientId).toBe("");
    expect(d.status).toBe("evaluating");
    expect(existsSync(path.join(dataDir, "interviews", iid, "recordings", rec.id, "chunks"))).toBe(false);

    const range = await bob.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/video`, undefined, {
      headers: { Range: "bytes=0-99" },
    });
    expect(range.status).toBe(206);
    expect(range.buf.length).toBe(100);
    expect(range.headers.get("content-type")).toBe("video/webm");
    expect(range.headers.get("content-range")).toBe(`bytes 0-99/${ready.sizeBytes}`);
    const full = await bob.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/video`);
    expect(full.status).toBe(200);
    expect(full.buf.length).toBe(ready.sizeBytes);
    // 完了後のチャンク再送は成功扱い
    expect((await put(2)).status).toBe(200);
    // ログインしていないと見られない
    expect((await admin().req("GET", `/api/interviews/${iid}/recordings/${rec.id}/video`)).status).toBe(401);
  });

  it("表情の計測データ: 受け取り → 集計 → マーカー変更で再集計", async () => {
    const gz = syntheticTrackGz();
    const r = await alice.req("PUT", `/api/interviews/${iid}/recordings/${rec.id}/track`, undefined, {
      raw: gz,
      contentType: "application/gzip",
      headers: fromDevice("local-000001"),
    });
    expect(r.status).toBe(200);
    // 計測済みの録画の計測し直し(上書き)は、録画した端末か管理者だけ
    const over = (who: Client, headers: Record<string, string> = {}) =>
      who.req("PUT", `/api/interviews/${iid}/recordings/${rec.id}/track`, undefined, { raw: gz, contentType: "application/gzip", headers });
    expect((await over(bob)).status).toBe(403);
    expect((await over(A)).status).toBe(200);
    const s = r.json.summary;
    expect(s.overall.expressiveness).toBeGreaterThan(0);
    expect(s.segments.map((x: { label: string }) => x.label)).toEqual(["自己紹介", "志望理由"]);
    expect(s.quality.level).toBe("high");

    const got = await bob.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/track`);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.buf, gz)).toBe(0);

    const m = await bob.req("PUT", `/api/interviews/${iid}/recordings/${rec.id}/markers`, {
      markers: [
        { tMs: 0, kind: "question", label: "自己紹介" },
        { tMs: 60_000, kind: "question", label: "志望理由" },
        { tMs: 120_000, kind: "question", label: "得意なこと" },
      ],
    });
    expect(m.json.summary.segments).toHaveLength(3);
    const sum = await bob.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/summary`);
    expect(sum.json.summary.segments).toHaveLength(3);

    const bad = await alice.req("PUT", `/api/interviews/${iid}/recordings/${rec.id}/track`, undefined, {
      raw: gzipSync(Buffer.from("garbage")),
      headers: fromDevice("local-000001"),
    });
    expect(bad.status).toBe(400);

    const stats = await bob.req("GET", "/api/stats/expression");
    expect(stats.json.items).toHaveLength(1);
    expect(stats.json.items[0].interviewId).toBe(iid);
  });

  it("評価: 自分が提出するまで他の人の評価は見えない", async () => {
    const ratings = { manner: 4, response: 3, motivation: 5, cooperation: 4, expression: 3 };
    // 下書き(不完全でも可)
    const draft = await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: { manner: 4 }, vote: null, comment: "途中" });
    expect(draft.status).toBe(200);
    expect(draft.json.evaluations.mine.status).toBe("draft");
    // 提出には全項目と総合評価が必要
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings: { manner: 4 }, vote: "pass", submit: true })).status).toBe(400);

    const b = await bob.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "hold", comment: "もう一度話を聞きたい", submit: true });
    expect(b.status).toBe(200);
    expect(b.json.evaluations.othersVisible).toBe(true); // bob は提出済み

    const aView = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(aView.evaluations.othersVisible).toBe(false);
    expect(aView.evaluations.others).toBeNull();
    expect(aView.evaluations.othersSubmittedCount).toBe(1);
    const aList = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(aList[0].votes).toBeNull();

    // 管理者は見える(画面では伏せてから表示)
    const adminView = (await A.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(adminView.evaluations.othersVisible).toBe(true);
    expect(adminView.evaluations.visibleBecauseAdmin).toBe(true);

    const a = await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { ratings, vote: "pass", comment: "受け答えが丁寧", submit: true });
    expect(a.json.evaluations.others).toHaveLength(1);
    expect(a.json.evaluations.others[0].vote).toBe("hold");
    expect(a.json.status).toBe("deciding");
    const list = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    expect(list[0].votes).toEqual({ pass: 1, hold: 1, fail: 0 });
    expect(list[0].submittedCount).toBe(2);
    expect(list[0].myEvaluation).toBe("submitted");
  });

  it("メモ: 時刻つきメモも評価と同じ公開範囲", async () => {
    const carol = admin();
    await A.req("POST", "/api/users", { loginId: "carol", name: "面接官C", role: "interviewer", password: "carol-pass1" });
    await carol.req("POST", "/api/login", { loginId: "carol", password: "carol-pass1" });
    const n = await alice.req("POST", `/api/interviews/${iid}/notes`, { recordingId: rec.id, tMs: 12_300, text: "ここの説明が具体的" });
    expect(n.status).toBe(200);
    const cv = (await carol.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(cv.notes.notes).toHaveLength(0);
    expect(cv.notes.hiddenCount).toBe(1);
    const bv = (await bob.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(bv.notes.notes[0].text).toBe("ここの説明が具体的");
    expect((await bob.req("DELETE", `/api/interviews/${iid}/notes/${n.json.note.id}`)).status).toBe(403);
  });

  it("判定は管理者のみ。判定後は評価を変更できない", async () => {
    expect((await alice.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "" })).status).toBe(403);
    const d = await A.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "2名の評価と録画を確認" });
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("decided");
    expect(d.json.interview.decision.decidedByName).toBe("代表");
    expect((await alice.req("PUT", `/api/interviews/${iid}/evaluations/me`, { vote: "fail", submit: true })).status).toBe(409);
    const cancel = await A.req("DELETE", `/api/interviews/${iid}/decision`);
    expect(cancel.json.status).toBe("deciding");
    await A.req("PUT", `/api/interviews/${iid}/decision`, { result: "pass", reason: "確定" });
  });

  it("保存期間: 判定から期限を過ぎた録画の映像は消え、集計の数値は残る", async () => {
    const res = await runRetention(app.ctx, Date.now() + 91 * 24 * 3600_000);
    expect(res.purged).toBe(1);
    const d = (await A.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    const r = d.interview.recordings[0];
    expect(r.status).toBe("purged");
    expect((await A.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/video`)).status).toBe(404);
    expect((await A.req("GET", `/api/interviews/${iid}/recordings/${rec.id}/summary`)).status).toBe(200);
    const dir = path.join(dataDir, "interviews", iid, "recordings", rec.id);
    expect(existsSync(path.join(dir, "video.webm"))).toBe(false);
    expect(existsSync(path.join(dir, "track.bin.gz"))).toBe(false);
    expect(existsSync(path.join(dir, "summary.json"))).toBe(true);
  });

  it("CSV 出力・操作ログ", async () => {
    const csv = await A.req("GET", "/api/export/interviews.csv");
    expect(csv.status).toBe(200);
    const text = csv.buf.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("山田 花子");
    expect(text).toContain("合格");
    expect((await alice.req("GET", "/api/export/interviews.csv")).status).toBe(403);

    const log = await A.req("GET", "/api/audit?limit=200");
    const actions = (log.json.entries as { action: string }[]).map((e) => e.action);
    for (const a of ["setup", "login", "interview_create", "consent_record", "recording_complete", "video_view", "evaluation_submit", "decision", "retention_purge", "export_csv"]) {
      expect(actions).toContain(a);
    }
    // 操作ログに候補者の氏名は書かない
    expect(JSON.stringify(log.json)).not.toContain("山田");
  });

  it("同意の取り消し(すべて)で録画が消え、面接の削除でディレクトリごと消える", async () => {
    const r = await alice.req("POST", "/api/interviews", { candidate: { displayName: "S.K." }, interviewerIds: [aliceId] });
    const id2 = r.json.interview.id as string;
    await alice.req("POST", `/api/interviews/${id2}/consent`, {
      recording: true, analysis: false, candidateName: "S.K.", method: "paper", consentText: "紙の同意書で取得(本文は別紙)",
    });
    const rc = await alice.req("POST", `/api/interviews/${id2}/recordings`, { clientId: "local-000002", source: "file", mimeType: "video/webm", fileName: "IMG_0001.webm" });
    const rid = rc.json.recording.id;
    expect(rc.json.recording.originalName).toBe("IMG_0001.webm");
    await alice.req("PUT", `/api/interviews/${id2}/recordings/${rid}/chunks/0`, undefined, {
      raw: readFileSync(path.join(__dirname, "fixtures", "chrome-recording-alpha.webm")),
      headers: fromDevice("local-000002"),
    });
    await alice.req("POST", `/api/interviews/${id2}/recordings/${rid}/complete`, { chunkCount: 1 }, { headers: fromDevice("local-000002") });
    await app.ctx.jobs.idle();
    // 計測への同意がないので顔トラックは受け付けない
    const t = await alice.req("PUT", `/api/interviews/${id2}/recordings/${rid}/track`, undefined, { raw: syntheticTrackGz() });
    expect(t.status).toBe(403);

    expect((await alice.req("POST", `/api/interviews/${id2}/consent/withdraw`, { scope: "all" })).status).toBe(403);
    const w = await A.req("POST", `/api/interviews/${id2}/consent/withdraw`, { scope: "all" });
    expect(w.json.interview.recordings[0].status).toBe("deleted");
    expect(existsSync(path.join(dataDir, "interviews", id2, "recordings", rid))).toBe(false);

    expect((await A.req("DELETE", `/api/interviews/${id2}`)).status).toBe(200);
    expect(existsSync(path.join(dataDir, "interviews", id2))).toBe(false);
    expect((await A.req("GET", `/api/interviews/${id2}`)).status).toBe(404);
  });

  it("再起動後もデータとセッションが残る", async () => {
    await app.close();
    const config = { ...loadConfig({}), dataDir, staticDir, setupCode: SETUP_CODE };
    app = await createApp(config, { log: false });
    const addr = await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${addr.port}`;
    const c = new Client();
    c.cookie = alice.cookie;
    const d = await c.req("GET", `/api/interviews/${iid}`);
    expect(d.status).toBe(200);
    expect(d.json.interview.decision.result).toBe("pass");
    expect((await c.req("GET", "/api/session")).json.needsSetup).toBe(false);
  });
});

describe("静的ファイル配信", () => {
  it("SPA のルートは index.html(CSP つき)、存在しないアセットは 404、ディレクトリ外は出さない", async () => {
    const root = await fetch(base + "/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(root.headers.get("x-frame-options")).toBe("DENY");
    const spa = await fetch(base + "/interviews/abc123");
    expect(await spa.text()).toContain("<title>t</title>");
    const asset = await fetch(base + "/assets/app-abc.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(base + "/assets/missing.js")).status).toBe(404);
    const trav = await fetch(base + "/..%2f..%2f..%2fetc%2fpasswd");
    expect(trav.status).toBe(404);
    const api404 = await fetch(base + "/api/nope");
    expect(api404.status).toBe(404);
  });
});

describe("録画の取り消しと再生用 MP4", () => {
  it("送信途中の録画は録画した本人が取り消せる。完了後は取り消せない", async () => {
    const A = new Client();
    await A.req("POST", "/api/login", { loginId: "boss", password: "password-123" });
    const iv = await A.req("POST", "/api/interviews", { candidate: { displayName: "取消 テスト" } });
    const id = iv.json.interview.id;
    await A.req("POST", `/api/interviews/${id}/consent`, {
      recording: true, analysis: true, candidateName: "取消", method: "paper", consentText: "紙の同意書で取得(本文は別紙)",
    });
    const r = await A.req("POST", `/api/interviews/${id}/recordings`, { clientId: "local-abort-1", source: "live", mimeType: "video/webm" });
    const rid = r.json.recording.id;
    await A.req("PUT", `/api/interviews/${id}/recordings/${rid}/chunks/0`, undefined, {
      raw: Buffer.from("partial"),
      headers: fromDevice("local-abort-1"),
    });
    const ab = await A.req("POST", `/api/interviews/${id}/recordings/${rid}/abort`, {});
    expect(ab.status).toBe(200);
    expect(ab.json.recording.status).toBe("deleted");
    expect(existsSync(path.join(dataDir, "interviews", id, "recordings", rid))).toBe(false);
    const d = await A.req("GET", `/api/interviews/${id}`);
    expect(d.json.status).toBe("scheduled");
    expect((await A.req("POST", `/api/interviews/${id}/recordings/${rid}/abort`, {})).status).toBe(409);
  });

  it.runIf(ffmpegAvailable())("ffmpeg があれば再生用の MP4(H.264)を作り、?format=mp4 で配信する", async () => {
    const A = new Client();
    await A.req("POST", "/api/login", { loginId: "boss", password: "password-123" });
    const iv = await A.req("POST", "/api/interviews", { candidate: { displayName: "MP4 テスト" } });
    const id = iv.json.interview.id;
    await A.req("POST", `/api/interviews/${id}/consent`, {
      recording: true, analysis: false, candidateName: "MP4", method: "paper", consentText: "紙の同意書で取得(本文は別紙)",
    });
    const r = await A.req("POST", `/api/interviews/${id}/recordings`, { clientId: "local-mp4-1", source: "live", mimeType: "video/webm;codecs=vp8,opus" });
    const rid = r.json.recording.id;
    await A.req("PUT", `/api/interviews/${id}/recordings/${rid}/chunks/0`, undefined, {
      raw: readFileSync(path.join(__dirname, "fixtures", "chrome-recording.webm")),
      headers: fromDevice("local-mp4-1"),
    });
    await A.req("POST", `/api/interviews/${id}/recordings/${rid}/complete`, { chunkCount: 1, durationMs: 4000 }, { headers: fromDevice("local-mp4-1") });
    await app.ctx.jobs.idle();
    const d = await A.req("GET", `/api/interviews/${id}`);
    const rec = d.json.interview.recordings[0];
    expect(rec.status).toBe("ready");
    expect(rec.mp4Ready).toBe(true);
    const mp4 = await A.req("GET", `/api/interviews/${id}/recordings/${rid}/video?format=mp4`, undefined, { headers: { Range: "bytes=0-31" } });
    expect(mp4.status).toBe(206);
    expect(mp4.headers.get("content-type")).toBe("video/mp4");
    expect(mp4.buf.subarray(4, 8).toString("latin1")).toBe("ftyp");
  }, 60_000);
});

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
