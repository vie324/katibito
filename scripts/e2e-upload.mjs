// 録画の送信の「困ったとき」の確認(ヘッドレス Chromium)。
// 端末内(IndexedDB)の録画を直接用意して、送信キューと画面の操作で回復できることを確かめる。
//   1. 端末内のデータが一部失われた録画 → 「送信できません」→「届いている部分で完了」→ 再生できる
//   2. サーバー側で失敗扱いになった録画 → 「送信できません」→「送り直す」→ 新しい録画として再生できる
//
// 実行: npm run build && npm run e2e:upload

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.E2E_OUT ?? path.join(root, "e2e-out");
const PORT = Number(process.env.E2E_PORT ?? 4518);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_CODE = "E2E0-UPLD";
const errors = [];
const log = (m) => console.log(`[e2e:upload] ${m}`);

if (!existsSync(path.join(root, "dist", "index.html")) || !existsSync(path.join(root, "dist-server", "main.js"))) {
  console.error("[e2e:upload] 先に npm run build を実行してください");
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "ktb-e2e-upload-"));
let server = null;

function startServer() {
  const p = spawn(process.execPath, [path.join(root, "dist-server", "main.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, INITIAL_SETUP_CODE: SETUP_CODE },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return p;
}

async function stopServer() {
  if (!server) return;
  const p = server;
  server = null;
  p.kill();
  await new Promise((r) => {
    p.once("exit", r);
    setTimeout(r, 5000);
  });
}

async function waitForServer(timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // 起動待ち
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("サーバーが起動しません");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function launch() {
  try {
    return await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined });
  } catch (e) {
    if (String(e).includes("Executable doesn't exist") && existsSync("/opt/pw-browsers/chromium")) {
      return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
    }
    throw e;
  }
}

/** ブラウザの中から API を呼ぶ(ログインの Cookie を使う) */
function api(page, method, p, body) {
  return page.evaluate(
    async ({ method, p, body }) => {
      const res = await fetch(p, {
        method,
        headers: { "X-Requested-With": "katibito", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, p, body },
  );
}

/** 端末内(IndexedDB)に録画を置く。chunks は [番号, base64] の組 */
function putLocalRecording(page, meta, chunks) {
  return page.evaluate(
    async ({ meta, chunks }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("katibito-local", 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction(["recordings", "chunks"], "readwrite");
      tx.objectStore("recordings").put(meta);
      for (const [i, b64] of chunks) {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        tx.objectStore("chunks").put(new Blob([bin], { type: "video/webm" }), `${meta.localId}:${String(i).padStart(6, "0")}`);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { meta, chunks },
  );
}

function localMeta(localId, interviewId, chunkCount, extra = {}) {
  const ended = Date.now() - 5 * 60_000;
  return {
    localId,
    interviewId,
    candidateName: "送信 テスト",
    source: "live",
    mimeType: "video/webm;codecs=vp8,opus",
    startedAt: new Date(ended - 60_000).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationMs: 60_000,
    status: "stopped",
    chunkCount,
    bytes: 0,
    serverRecordingId: null,
    markers: [],
    hasTrack: false,
    analysisAllowed: false,
    trackUploaded: false,
    completed: false,
    lastError: null,
    heartbeatAt: ended,
    recovered: false,
    doneAt: null,
    ...extra,
  };
}

async function waitFor(fn, what, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`待ちきれません: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let browser = null;
try {
  server = startServer();
  await waitForServer();
  browser = await launch();
  const ctx = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());

  // ------------------------------------------------------------ 準備(管理者・面接・同意)
  await page.goto(BASE);
  const setup = await api(page, "POST", "/api/setup", {
    setupCode: SETUP_CODE,
    orgName: "送信テスト",
    loginId: "boss",
    name: "管理者",
    password: "admin-pass-123",
  });
  if (setup.status !== 200) throw new Error(`初期設定に失敗: ${JSON.stringify(setup.json)}`);
  const iv = await api(page, "POST", "/api/interviews", { candidate: { displayName: "送信 テスト" } });
  const iid = iv.json.interview.id;
  const consent = await api(page, "POST", `/api/interviews/${iid}/consent`, {
    recording: true,
    analysis: false,
    candidateName: "送信 テスト",
    method: "paper",
    consentText: "紙の同意書で取得(本文は別紙)",
  });
  if (consent.status !== 200) throw new Error("同意の記録に失敗");
  await page.goto(BASE); // アプリを開いて端末内のデータベースを作らせる
  await page.getByRole("heading", { name: "面接一覧" }).waitFor();

  const webm = readFileSync(path.join(root, "tests", "fixtures", "chrome-recording.webm"));
  const parts = [webm.subarray(0, 20_000), webm.subarray(20_000, 50_000), webm.subarray(50_000)].map((b) => b.toString("base64"));
  const recordings = async () => (await api(page, "GET", `/api/interviews/${iid}`)).json.interview.recordings;

  // ------------------------------------------------------------ 1. 端末内のデータの一部が失われた
  await putLocalRecording(page, localMeta("e2emissing0000000001", iid, 3), [
    [0, parts[0]],
    [2, parts[2]],
  ]);
  await page.reload();
  await page.locator(".upload-indicator").waitFor({ timeout: 30_000 });
  await page.locator(".upload-indicator").click();
  await page.getByText("端末内の録画データの一部").waitFor({ timeout: 30_000 });
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, "upload-1-missing.png") });
  log("データの欠け: 「送信できません」で止まる(無限に再試行しない)");
  await page.getByRole("button", { name: "届いている部分で完了" }).click();
  const partial = await waitFor(async () => {
    const recs = await recordings();
    return recs.find((r) => r.status === "ready") ?? null;
  }, "届いている部分の録画が再生できるようになる");
  if (partial.chunkCount !== 1) errors.push(`届いている部分で完了: chunkCount が ${partial.chunkCount}(1 のはず)`);
  await page.locator(".upload-indicator").waitFor({ state: "detached", timeout: 30_000 });
  log("データの欠け: 「届いている部分で完了」で再生できる録画になった");

  // ------------------------------------------------------------ 2. サーバー側で失敗扱いになった
  const localId = "e2efailed00000000001";
  const created = await api(page, "POST", `/api/interviews/${iid}/recordings`, {
    clientId: localId,
    source: "live",
    mimeType: "video/webm;codecs=vp8,opus",
    startedAt: new Date().toISOString(),
  });
  const failedRid = created.json.recording.id;
  // 長期間届かなかった録画を、保存期間の処理が失敗扱いにした状態を作る(サーバーを止めてデータを書き換える)
  await stopServer();
  const ivFile = path.join(dataDir, "interviews", iid, "interview.json");
  const stored = JSON.parse(readFileSync(ivFile, "utf8"));
  const target = stored.recordings.find((r) => r.id === failedRid);
  target.status = "failed";
  target.error = "アップロードが完了しないまま保存期間を過ぎたため削除しました";
  writeFileSync(ivFile, JSON.stringify(stored, null, 2));
  server = startServer();
  await waitForServer();

  await putLocalRecording(page, localMeta(localId, iid, 3, { serverRecordingId: failedRid }), [
    [0, parts[0]],
    [1, parts[1]],
    [2, parts[2]],
  ]);
  await page.reload();
  await page.locator(".upload-indicator").waitFor({ timeout: 30_000 });
  await page.locator(".upload-indicator").click();
  await page.getByText("サーバー側で録画が失敗扱い").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(outDir, "upload-2-server-failed.png") });
  log("サーバー側の失敗: 端末内のデータを残して「送信できません」で止まる");
  await page.getByRole("button", { name: "送り直す" }).click();
  const resent = await waitFor(async () => {
    const recs = await recordings();
    return recs.find((r) => r.status === "ready" && r.id !== partial.id) ?? null;
  }, "送り直した録画が再生できるようになる");
  if (resent.chunkCount !== 3) errors.push(`送り直し: chunkCount が ${resent.chunkCount}(3 のはず)`);
  await page.locator(".upload-indicator").waitFor({ state: "detached", timeout: 30_000 });
  const recs = await recordings();
  if (recs.find((r) => r.id === failedRid)?.status !== "failed") errors.push("失敗扱いの録画の状態が変わっている");
  log("サーバー側の失敗: 「送り直す」で新しい録画として再生できるようになった");

  // 送信が済んだ録画は、端末内の映像が消えていること
  const leftover = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("katibito-local", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const n = await new Promise((resolve) => {
      const req = db.transaction("chunks").objectStore("chunks").count();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return n;
  });
  if (leftover !== 0) errors.push(`送信済みなのに端末内に ${leftover} 個のデータが残っている`);
  else log("送信が済んだ録画の端末内のデータは消えた");
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // 後片付けの失敗は結果に影響させない
  }
}

if (errors.length > 0) {
  console.error("[e2e:upload] 失敗:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
log("OK");
