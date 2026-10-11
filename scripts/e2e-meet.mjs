// オンライン面接(Google Meet)の録画のエンドツーエンド確認(ヘッドレス Chromium)。
// 偽の「Meet」のページ(候補者の大きなタイルと、面接官の小さなタイル)を別のタブで開き、
// 実際の画面の共有(タブの共有)で録画する。共有するタブは Chromium の起動オプションで自動で選ぶ:
//   --auto-select-tab-capture-source-by-title=<タブのタイトル>
//   --use-fake-device-for-media-stream(マイクは合成の音。ヘッドレスではタブの音は無音になる)
//   ※ --use-fake-ui-for-media-stream を付けると、タイトルの指定より優先して「このタブ」が共有されるため付けない
//
// ※ ヘッドレスの Chromium では、タブの共有を完全に終える(映像と音声の両方を止める・共有中のタブを閉じる)と
//   ブラウザごと落ちる(画面のない環境の不具合。実際の Chrome では起きない)。そのためテストでは、
//   タブの音声のトラックを止める操作だけを無視し、「共有を停止」は映像のトラックの ended を起こして再現する。
//   ページの読み込み直し(page.goto)でも共有が終わるため、共有を始めたあとは画面の中のリンクで移動する。
//
// 流れ: 初期設定(API)→ オンライン面接の登録(画面)→ 同意のリンクを作る → 保護者がリンクから回答 →
// 自動で撮影準備へ → Meet のタブを選ぶ → 候補者の顔を検出 → 録画(途中で Meet のタブを表に出す)→ 送信 →
// 再生・表情の計測 → もう一度録画して共有を止める → 自動で録画が終わる
//
// 実行: npm run build && npm run e2e:meet   スクリーンショットは e2e-out/meet/ に保存される。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.E2E_OUT ?? path.join(root, "e2e-out", "meet");
const assetDir = path.join(root, "e2e-out", "assets");
mkdirSync(outDir, { recursive: true });
mkdirSync(assetDir, { recursive: true });

const PORT = Number(process.env.E2E_PORT ?? 4527);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_CODE = "E2E0-MEET";
const ADMIN = { loginId: "boss", name: "管理 花子", password: "admin-pass-123" };
const MEET_TITLE = "Meet - abc-defg-hij";

const errors = [];
const log = (m) => console.log(`[e2e:meet] ${m}`);
let shot = 0;
async function snap(page, name, fullPage = false) {
  shot++;
  await page.screenshot({ path: path.join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage });
}

// ---------------------------------------------------------------- テスト素材(e2e.mjs と同じ公開素材)

const IMAGES = { neutral: "mozart_square.jpg", smile: "face_stylizer_test_image.png", interviewer: "business-person.png" };

async function fetchAssets() {
  const out = {};
  for (const [key, name] of Object.entries(IMAGES)) {
    const file = path.join(assetDir, name);
    if (!existsSync(file)) {
      try {
        const res = await fetch(`https://storage.googleapis.com/mediapipe-assets/${name}`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        log(`テスト画像を取得できません(${name}: ${e.message})。顔なしで実行します`);
        return null;
      }
    }
    out[key] = `data:${name.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${readFileSync(file).toString("base64")}`;
  }
  return out;
}

/** 偽の Meet のページ。候補者の大きなタイル(無表情と笑顔を繰り返す)と、面接官2人の小さなタイル */
function meetPage(images) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${MEET_TITLE}</title>
<style>html,body{margin:0;height:100%;background:#202124;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style></head>
<body><canvas id="c"></canvas><script>
const imgs = ${JSON.stringify(images)};
const cv = document.getElementById("c");
const c = cv.getContext("2d");
const load = (src) => new Promise((r) => { if (!src) return r(null); const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = src; });
Promise.all([load(imgs && imgs.neutral), load(imgs && imgs.smile), load(imgs && imgs.interviewer)]).then(([neutral, smile, iv]) => {
  const t0 = performance.now();
  const phase = (t) => { const s = t % 20; return s >= 6 && s < 10 ? "smile" : "neutral"; };
  const tile = (x, y, w, h, name) => { c.fillStyle = "#3c4043"; c.fillRect(x, y, w, h); c.fillStyle = "#e8eaed"; c.font = "16px sans-serif"; c.fillText(name, x + 12, y + h - 14); };
  setInterval(() => {
    const W = (cv.width = innerWidth), H = (cv.height = innerHeight);
    const t = (performance.now() - t0) / 1000;
    c.fillStyle = "#202124"; c.fillRect(0, 0, W, H);
    const bw = W * 0.72, bh = H - 110;
    tile(16, 16, bw, bh, "候補者");
    const p = phase(t), sway = Math.sin(t * 1.3) * 6, nod = Math.sin(t * 2.2) * 4;
    const fw = Math.min(bw, bh) * 0.62;
    const fx = 16 + (bw - fw) / 2 + sway, fy = 16 + (bh - fw) / 2 - 20 + nod;
    if (p === "neutral" && neutral) {
      const sx = neutral.width * 0.24, sw = neutral.width * 0.5, sh = neutral.height * 0.62;
      c.drawImage(neutral, sx, neutral.height * 0.02, sw, sh, fx, fy, fw, (fw * sh) / sw);
    } else if (p === "smile" && smile) {
      c.drawImage(smile, fx, fy, fw, fw);
    }
    const sw2 = W - bw - 48, sh2 = (bh - 16) / 2;
    for (const [i, name] of [[0, "面接官A"], [1, "面接官B"]]) {
      const x = bw + 32, y = 16 + i * (sh2 + 16);
      tile(x, y, sw2, sh2, name);
      if (iv) { const w = iv.width * 0.45, h = iv.height * 0.34, dw = sw2 * 0.6; c.drawImage(iv, iv.width * 0.28, iv.height * 0.02, w, h, x + (sw2 - dw) / 2, y + 16, dw, (dw * h) / w); }
    }
    // 下のボタンの並び(Meet らしく)
    for (let i = 0; i < 5; i++) { c.fillStyle = i === 4 ? "#ea4335" : "#3c4043"; c.beginPath(); c.arc(W / 2 - 120 + i * 60, H - 46, 22, 0, Math.PI * 2); c.fill(); }
  }, 33);
});
</script></body></html>`;
}

// ---------------------------------------------------------------- サーバー

function waitForServer(url, timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        // 起動待ち
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`サーバーが起動しません: ${url}`));
      setTimeout(tick, 300);
    };
    void tick();
  });
}

if (!existsSync(path.join(root, "dist", "index.html")) || !existsSync(path.join(root, "dist-server", "main.js"))) {
  console.error("[e2e:meet] 先に npm run build を実行してください");
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "ktb-e2e-meet-"));
const server = spawn(process.execPath, [path.join(root, "dist-server", "main.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, INITIAL_SETUP_CODE: SETUP_CODE, TRANSCODE: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let meetServer = null;
let browser = null;

function watch(page, label) {
  page.on("crash", () => errors.push(`${label}: ページがクラッシュしました`));
  if (process.env.MEET_DEBUG) page.on("close", () => console.log(`[${label}] page closed at ${new Date().toISOString()}`));
  if (process.env.MEET_DEBUG) page.on("console", (m) => console.log(`[${label}:${m.type()}] ${m.text()}`.slice(0, 400)));
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|TensorFlow Lite|XNNPACK|GL Driver|gl_context|^[IWE]\d{4} /.test(m.text())) {
      errors.push(`${label} console: ${m.text()}`);
    }
  });
}

try {
  await waitForServer(`${BASE}/api/health`);
  const images = await fetchAssets();
  const html = meetPage(images);
  meetServer = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((r) => meetServer.listen(0, "127.0.0.1", r));
  const MEET_PAGE = `http://127.0.0.1:${meetServer.address().port}/abc-defg-hij`;
  log("サーバー起動");

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    args: [
      "--autoplay-policy=no-user-gesture-required",
      `--auto-select-tab-capture-source-by-title=${MEET_TITLE}`,
      "--use-fake-device-for-media-stream",
    ],
  });
  if (process.env.MEET_DEBUG) browser.on("disconnected", () => console.log(`[browser] disconnected at ${new Date().toISOString()}`));
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["camera", "microphone"],
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  await ctx.addInitScript(() => {
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      if (this.kind === "audio" && this.label === "Tab audio") return;
      return stop.call(this);
    };
  });
  const api = async (method, p, body) => {
    const r = await ctx.request.fetch(`${BASE}${p}`, {
      method,
      headers: { "X-Requested-With": "katibito", "Content-Type": "application/json" },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status(), json: await r.json().catch(() => null) };
  };

  // ------------------------------------------------------------ 初期設定(API)
  const setup = await api("POST", "/api/setup", { setupCode: SETUP_CODE, orgName: "テスト教室", loginId: ADMIN.loginId, name: ADMIN.name, password: ADMIN.password });
  if (setup.status !== 200) throw new Error(`初期設定に失敗: ${JSON.stringify(setup.json)}`);

  // Meet(偽物)を先に開いておく
  const meet = await ctx.newPage();
  await meet.goto(MEET_PAGE);
  const page = await ctx.newPage();
  watch(page, "app");
  await page.goto(BASE);
  await page.getByRole("heading", { name: "面接一覧" }).waitFor();

  // ------------------------------------------------------------ オンライン面接の登録(画面)
  await page.getByRole("button", { name: "面接を登録" }).click();
  await page.getByLabel("表示名").fill("オンライン 花");
  await page.getByLabel("年齢").fill("11");
  await page.getByText("オンライン(Google Meet)", { exact: true }).click();
  await page.getByLabel("Google Meet のリンク").fill("zoom.us/j/123");
  await page.getByText("Google Meet のリンク(https://meet.google.com/… の形)を入れてください").waitFor();
  await page.getByLabel("Google Meet のリンク").fill("meet.google.com/abc-defg-hij?authuser=0");
  await page.locator(".checks label", { hasText: ADMIN.name }).locator("input").check();
  await snap(page, "interview-new-online", true);
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByRole("heading", { name: "オンライン 花" }).waitFor();
  const interviewUrl = page.url();
  const iid = interviewUrl.split("/").pop();
  const meetHref = await page.getByRole("link", { name: "Meet を開く" }).getAttribute("href");
  if (meetHref !== "https://meet.google.com/abc-defg-hij") errors.push(`Meet のリンクが正規化されていない: ${meetHref}`);
  await page.getByText("オンライン(Google Meet)").first().waitFor();
  await snap(page, "detail-online");
  log("オンライン面接の登録 OK(Meet のリンクを正規化して保存)");

  // ------------------------------------------------------------ 同意: リンクを Meet のチャットに貼る → 保護者が回答
  await page.getByRole("button", { name: "同意を取得して録画" }).click();
  await page.getByText("オンライン面接(Google Meet)です").waitFor();
  await page.getByRole("button", { name: "同意のリンクを作る" }).click();
  const message = await page.locator("textarea.copy-box").inputValue();
  const link = message.match(/https?:\/\/\S+\/c\/[A-Za-z0-9_-]+/)?.[0];
  if (!link || !message.includes("保護者の方がご回答ください")) throw new Error(`同意のリンクの文面が想定外: ${message}`);
  await snap(page, "consent-online-link");

  const guardianCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "ja-JP" });
  const guardian = await guardianCtx.newPage();
  watch(guardian, "guardian");
  await guardian.goto(link);
  await guardian.locator("fieldset", { hasText: "面接の録画に同意しますか" }).getByText("同意する", { exact: true }).click();
  await guardian.locator("fieldset", { hasText: "表情の計測に同意しますか" }).getByText("同意する", { exact: true }).click();
  await guardian.getByLabel("面接を受ける方のお名前").fill("オンライン 花");
  await guardian.getByLabel("保護者の方のお名前").fill("オンライン 一郎");
  await guardian.getByLabel("続柄").fill("父");
  await guardian.getByText("上の説明を読み、内容を理解しました").click();
  await guardian.getByRole("button", { name: "この内容で回答する" }).click();
  await guardian.getByText("ご回答ありがとうございました").waitFor();
  await guardianCtx.close();
  // 回答が届くと、録画の画面が自動で撮影の準備に進む
  await page.getByText("撮影の準備").waitFor({ timeout: 15_000 });
  log("同意: Meet のチャット用のリンクから保護者が回答 → 自動で撮影の準備へ OK");

  // ------------------------------------------------------------ Meet のタブを選ぶ
  const meetSeg = page.locator(".source-switch .seg", { hasText: "Google Meet" });
  if (!(await meetSeg.getAttribute("class")).includes("on")) errors.push("オンライン面接なのに、録画する映像が Google Meet になっていない");
  if ((await page.getByLabel("カメラ").count()) > 0) errors.push("Meet の録画でカメラの選択が出ている");
  await page.getByRole("button", { name: "Meet のタブを選ぶ" }).click();
  await page.getByRole("button", { name: "Meet のタブを選び直す" }).waitFor({ timeout: 15_000 });
  const surface = await page.evaluate(() => document.querySelector(".stage-box video")?.srcObject?.getVideoTracks()[0]?.getSettings().displaySurface);
  // 共有されたのが Meet のタブであること(このアプリの画面ではない): 映像の左上は Meet の背景色
  const corner = await page.evaluate(() => {
    const v = document.querySelector(".stage-box video");
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const x = c.getContext("2d");
    x.drawImage(v, 0, 0, 320, 180);
    return Array.from(x.getImageData(1, 1, 1, 1).data.slice(0, 3));
  });
  if (Math.abs(corner[0] - 0x20) > 12 || Math.abs(corner[1] - 0x21) > 12 || Math.abs(corner[2] - 0x24) > 12) {
    errors.push(`共有された映像が Meet のタブではない(左上の色 ${corner.join(",")})`);
  }
  if (surface !== "browser") errors.push(`共有したものがタブではない: ${surface}`);
  if (await page.getByText("タブの音声が共有されていません").count()) errors.push("タブの音声が共有されていない扱いになっている");
  if (images) {
    await page.getByText("候補者の顔を検出しています").waitFor({ timeout: 90_000 });
    log("Meet のタブを共有 → 候補者の顔を検出 OK");
  } else {
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(1000);
  // 自分のアプリに戻ったまま(Meet のタブへ切り替わっていない)
  const focusStayed = await page.evaluate(() => document.visibilityState === "visible");
  if (!focusStayed) errors.push("共有を始めたあと、アプリの画面が裏に回っている");
  await snap(page, "studio-meet-setup");

  // ------------------------------------------------------------ 録画(途中で Meet のタブを表に出す)
  await page.getByRole("button", { name: "録画を開始" }).click();
  await page.getByText("録画中", { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".qbtn", { hasText: "自己紹介" }).click();
  await page.waitForTimeout(3000);
  await snap(page, "studio-meet-recording");
  await meet.bringToFront();
  await page.waitForTimeout(500);
  const hiddenState = await page.evaluate(() => document.visibilityState);
  log(`Meet のタブを表に出した(アプリの画面: ${hiddenState})`);
  await page.waitForTimeout(6000);
  await page.bringToFront();
  await page.waitForTimeout(2500);
  await page.locator(".qbtn", { hasText: "志望理由" }).click();
  await page.waitForTimeout(2500);
  if (await page.getByText("録画中に別の画面に切り替えた時間がありました").count()) {
    errors.push("トラックから計測しているのに「計測されていない時間がある」と表示された");
  }
  await page.getByRole("button", { name: "録画を終了" }).click();
  await page.locator(".modal").getByRole("button", { name: "録画を終了する" }).click();
  await page.getByText("送信が完了しました").waitFor({ timeout: 60_000 });
  log("録画 → 送信 OK");

  // ------------------------------------------------------------ 再生・表情の計測
  await page.getByRole("button", { name: "面接の詳細へ(評価の入力)" }).click();
  await page.getByText("Google Meet の画面から録画").waitFor({ timeout: 30_000 });
  await page.locator(".review-video video").waitFor({ timeout: 60_000 });
  const detail = (await api("GET", `/api/interviews/${iid}`)).json;
  const rec = detail.interview.recordings[0];
  if (rec.capture !== "screen") errors.push(`録画の映像の元が screen ではない: ${rec.capture}`);
  if (images) {
    await page.getByText("表情の豊かさ(総合)").first().waitFor({ timeout: 30_000 });
    await page.getByText("オンライン面接(Google Meet)の映像から計測しています").waitFor();
    const sum = (await api("GET", `/api/interviews/${iid}/recordings/${rec.id}/summary`)).json.summary;
    const coverage = sum.overall.detectedSec / (sum.durationMs / 1000);
    log(`表情の計測: 長さ ${(sum.durationMs / 1000).toFixed(1)} 秒 / 顔を計測 ${sum.overall.detectedSec.toFixed(1)} 秒(${Math.round(coverage * 100)}%)/ ${sum.frameCount} フレーム`);
    // 偽の Meet の候補者はずっと映っている
    if (hiddenState === "hidden" && coverage < 0.8) errors.push(`アプリの画面が裏に回っている間の計測が抜けている(${Math.round(coverage * 100)}%)`);
    if (coverage < 0.5) errors.push(`計測できた時間が短すぎる(${Math.round(coverage * 100)}%)`);
  }
  await page.waitForTimeout(800);
  await snap(page, "review-meet", true);
  log("再生・計測 OK");

  // ------------------------------------------------------------ もう一度録画して、共有を止める → 自動で録画が終わる
  await page.getByRole("button", { name: "録画を開始" }).click();
  await page.getByText("撮影の準備").waitFor();
  await page.getByRole("button", { name: "Meet のタブを選ぶ" }).click();
  await page.getByRole("button", { name: "Meet のタブを選び直す" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "録画を開始" }).click();
  await page.getByText("録画中", { exact: true }).waitFor();
  await page.waitForTimeout(3000);
  // Chrome の「共有を停止」・共有中のタブを閉じたとき: 映像のトラックが終わる
  await page.evaluate(() => document.querySelector(".stage-box video").srcObject.getVideoTracks()[0].dispatchEvent(new Event("ended")));
  await page.getByText("Meet の画面の共有が止まったため、録画を終了しました").waitFor({ timeout: 15_000 });
  await page.getByText("送信が完了しました").waitFor({ timeout: 60_000 });
  await snap(page, "share-stopped");
  const after = (await api("GET", `/api/interviews/${iid}`)).json;
  const ready = after.interview.recordings.filter((r) => r.status === "ready" && r.capture === "screen").length;
  if (ready !== 2) errors.push(`Meet の録画が2件そろっていない(${ready}件)`);
  log("共有を止める → 録画を自動で終了・送信 OK");
} catch (e) {
  errors.push(`中断: ${e.stack ?? e}`);
} finally {
  await browser?.close().catch(() => undefined);
  meetServer?.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (errors.length > 0) {
  console.error("[e2e:meet] 失敗:");
  for (const e of errors) console.error(`  - ${e}`);
  if (process.env.E2E_SERVER_LOG) console.error(serverLog);
  process.exit(1);
}
log(`OK — スクリーンショット: ${outDir}`);
