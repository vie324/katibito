// 運用版のエンドツーエンド確認(ヘッドレス Chromium)。
// 初期設定 → ユーザー追加 → 面接登録 → 同意 → 録画(合成カメラ)→ 送信 → 再生・表情の計測 →
// 評価(非公開ルール)→ 判定 → 動画の取り込み、までを画面操作で通す。
//
// 実行: npm run build && npm run e2e
// スクリーンショットは e2e-out/ に保存される。
//
// カメラ映像は canvas で合成する。顔は MediaPipe のテスト画像(公開素材)を使う:
//   候補者(無表情)= mozart_square.jpg / 候補者(笑顔)= face_stylizer_test_image.png /
//   映り込む面接官 = business-person.png
// 画像を取得できない環境では顔なしの映像で流れだけを確認する。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.E2E_OUT ?? path.join(root, "e2e-out");
const assetDir = path.join(outDir, "assets");
mkdirSync(assetDir, { recursive: true });

const PORT = Number(process.env.E2E_PORT ?? 4517);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_CODE = "E2E0-TEST";
const ADMIN = { loginId: "boss", name: "管理 花子", password: "admin-pass-123" };
const STAFF = { loginId: "alice", name: "面接官 一郎", password: "alice-pass-123" };

const errors = [];
const log = (m) => console.log(`[e2e] ${m}`);
let shot = 0;
async function snap(page, name, fullPage = false) {
  shot++;
  await page.screenshot({ path: path.join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage });
}

// ---------------------------------------------------------------- テスト素材

const IMAGES = {
  neutral: "mozart_square.jpg",
  smile: "face_stylizer_test_image.png",
  interviewer: "business-person.png",
};

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
    const mime = name.endsWith(".png") ? "image/png" : "image/jpeg";
    out[key] = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
  }
  return out;
}

/** 取り込み用の動画(WebM)を ffmpeg で作る。表情の時間割はカメラ合成と同じ */
function makeImportVideo() {
  const file = path.join(assetDir, "import-test.webm");
  if (existsSync(file)) return file;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    log("ffmpeg がないため、取り込みの確認は省略します");
    return null;
  }
  const n = path.join(assetDir, IMAGES.neutral);
  const s = path.join(assetDir, IMAGES.smile);
  const i = path.join(assetDir, IMAGES.interviewer);
  if (![n, s, i].every(existsSync)) return null;
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x6b6f75:s=640x360:d=24:r=15",
      "-loop", "1", "-i", n, "-loop", "1", "-i", s, "-loop", "1", "-i", i,
      "-f", "lavfi", "-i", "sine=frequency=220:d=24",
      "-filter_complex",
      [
        "[1]crop=iw*0.5:ih*0.62:iw*0.24:ih*0.02,scale=-1:180[n]",
        "[2]scale=-1:180[s]",
        "[3]crop=iw*0.45:ih*0.34:iw*0.28:ih*0.02,scale=-1:110[i]",
        "[0][i]overlay=500:200[b0]",
        "[b0][n]overlay=(W-w)/2:70:enable='not(between(t,6,10)+between(t,14,17)+between(t,19,22))'[b1]",
        "[b1][s]overlay=(W-w)/2:70:enable='between(t,6,10)+between(t,19,22)'[v]",
      ].join(";"),
      "-map", "[v]", "-map", "4:a",
      "-t", "24", "-c:v", "libvpx", "-b:v", "600k", "-c:a", "libopus", file,
    ],
    { stdio: "inherit" },
  );
  return file;
}

/** getUserMedia を合成ストリームに差し替える(実際の MediaStream / MediaRecorder / Web Audio の経路を通す) */
async function installSyntheticCamera(ctx, images) {
  await ctx.addInitScript((imgs) => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.enumerateDevices = async () => [
      { deviceId: "synthetic-cam", kind: "videoinput", label: "合成カメラ", groupId: "g" },
      { deviceId: "synthetic-mic", kind: "audioinput", label: "合成マイク", groupId: "g" },
    ];
    md.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const c = canvas.getContext("2d");
      const load = (src) =>
        new Promise((resolve) => {
          if (!src) return resolve(null);
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = src;
        });
      const [neutral, smile, interviewer] = await Promise.all([load(imgs?.neutral), load(imgs?.smile), load(imgs?.interviewer)]);
      const t0 = performance.now();
      // 表情の時間割(40秒周期): 無表情 → 笑顔 → 無表情 → 顔なし → 笑顔 → 無表情
      const phase = (t) => {
        const s = t % 40;
        if (s >= 6 && s < 10) return "smile";
        if (s >= 18 && s < 23) return "none";
        if (s >= 23 && s < 27) return "smile";
        return "neutral";
      };
      setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        c.fillStyle = "#6b6f75";
        c.fillRect(0, 0, 1280, 720);
        c.fillStyle = "#585c62";
        c.fillRect(0, 520, 1280, 200);
        if (interviewer) {
          // 横に座る面接官の顔(小さく映り込む)
          const w = interviewer.width * 0.45;
          const h = interviewer.height * 0.34;
          c.drawImage(interviewer, interviewer.width * 0.28, interviewer.height * 0.02, w, h, 1000, 380, 200, (200 * h) / w);
        }
        const p = phase(t);
        const sway = Math.sin(t * 1.3) * 6;
        const nod = Math.sin(t * 2.2) * 4;
        if (p === "neutral" && neutral) {
          const sx = neutral.width * 0.24;
          const sw = neutral.width * 0.5;
          const sh = neutral.height * 0.62;
          c.drawImage(neutral, sx, neutral.height * 0.02, sw, sh, 470 + sway, 110 + nod, 340, (340 * sh) / sw);
        } else if (p === "smile" && smile) {
          c.drawImage(smile, 470 + sway, 110 + nod, 340, 340);
        }
        if (!imgs) {
          c.fillStyle = `hsl(${(t * 30) % 360},30%,40%)`;
          c.fillRect(560, 200, 160, 200);
        }
      }, 33);
      const vstream = canvas.captureStream(30);
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      osc.frequency.value = 180;
      const gain = ac.createGain();
      gain.gain.value = 0;
      setInterval(() => {
        gain.gain.value = Math.sin(Date.now() / 600) > -0.3 ? 0.3 : 0;
      }, 60);
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      return new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
  }, images);
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
  console.error("[e2e] 先に npm run build を実行してください");
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "ktb-e2e-"));
const server = spawn(process.execPath, [path.join(root, "dist-server", "main.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, INITIAL_SETUP_CODE: SETUP_CODE },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let browser = null;

async function launch() {
  const args = ["--autoplay-policy=no-user-gesture-required"];
  try {
    return await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined, args });
  } catch (e) {
    if (String(e).includes("Executable doesn't exist") && existsSync("/opt/pw-browsers/chromium")) {
      return chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args });
    }
    throw e;
  }
}

async function newPage(images, label) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["camera", "microphone"],
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  await installSyntheticCamera(ctx, images);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    // MediaPipe(WASM)は情報ログも console.error に出すので除外する
    if (m.type() === "error" && !/Failed to load resource|favicon|TensorFlow Lite|XNNPACK|GL Driver|gl_context|^[IWE]\d{4} /.test(m.text())) {
      errors.push(`${label} console: ${m.text()}`);
    }
  });
  return page;
}

async function rate(page, ratings) {
  const crit = page.locator(".my-eval .criterion");
  const n = await crit.count();
  for (let i = 0; i < n; i++) {
    await crit.nth(i).locator(".scale-btn").nth(ratings[i % ratings.length] - 1).click();
  }
}

try {
  await waitForServer(`${BASE}/api/health`);
  log("サーバー起動");
  const images = await fetchAssets();
  browser = await launch();

  // ------------------------------------------------------------ 初期設定
  const page = await newPage(images, "admin");
  await page.goto(BASE);
  await page.waitForURL("**/setup");
  await page.getByLabel("初期設定コード").fill(SETUP_CODE);
  await page.getByLabel("団体名").fill("テスト教室");
  await page.getByLabel("管理者の氏名").fill(ADMIN.name);
  await page.getByLabel("ログインID").fill(ADMIN.loginId);
  await page.getByRole("textbox", { name: "パスワード", exact: true }).fill(ADMIN.password);
  await page.getByLabel("パスワード(確認)").fill(ADMIN.password);
  await snap(page, "setup");
  await page.getByRole("button", { name: "管理者を作成して始める" }).click();
  await page.getByRole("heading", { name: "面接一覧" }).waitFor();
  log("初期設定 OK");

  // ------------------------------------------------------------ ユーザー追加
  await page.getByRole("link", { name: "設定" }).click();
  await page.getByRole("button", { name: "ユーザー", exact: true }).click();
  await page.getByRole("button", { name: "ユーザーを追加" }).click();
  await page.getByLabel("氏名").fill(STAFF.name);
  await page.getByLabel("ログインID").fill(STAFF.loginId);
  await page.getByLabel("初期パスワード").fill(STAFF.password);
  await page.locator(".modal").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("cell", { name: STAFF.loginId }).waitFor();
  await snap(page, "users");
  log("ユーザー追加 OK");

  // ------------------------------------------------------------ 面接の登録
  await page.getByRole("link", { name: "面接一覧" }).click();
  await page.getByRole("button", { name: "面接を登録" }).click();
  await page.getByLabel("表示名").fill("テスト 太郎");
  await page.getByLabel("ふりがな").fill("てすと たろう");
  await page.getByLabel("年齢").fill("12");
  await page.locator(".checks label", { hasText: ADMIN.name }).locator("input").check();
  await page.locator(".checks label", { hasText: STAFF.name }).locator("input").check();
  await snap(page, "interview-new");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByRole("heading", { name: "テスト 太郎" }).waitFor();
  const interviewUrl = page.url();
  log(`面接の登録 OK (${interviewUrl})`);

  // ------------------------------------------------------------ 同意 → 撮影準備
  await page.getByRole("button", { name: "同意を取得して録画" }).click();
  await page.getByText("面接の録画と表情の計測についてのお願い").waitFor();
  await page.getByText("面接の録画に同意します").click();
  await page.getByText("録画からの表情の計測に同意します").click();
  await page.getByLabel("ご本人のお名前").fill("テスト 太郎");
  await page.getByLabel("保護者のお名前").fill("テスト 花子");
  await page.getByLabel("続柄").fill("母");
  await snap(page, "consent", true);
  await page.getByRole("button", { name: "同意を記録して撮影の準備へ" }).click();
  await page.getByText("撮影の準備").waitFor();
  if (images) {
    await page.getByText("候補者の顔を検出しています").waitFor({ timeout: 90_000 });
    log("撮影準備: 候補者の顔を検出");
  } else {
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(1500);
  await snap(page, "studio-setup");

  // 面接官は別の端末でログインしておく(録画中にライブで見る)
  const staff = await newPage(images, "staff");
  await staff.goto(`${BASE}/login`);
  await staff.getByLabel("ログインID").fill(STAFF.loginId);
  await staff.getByRole("textbox", { name: "パスワード", exact: true }).fill(STAFF.password);
  await staff.getByRole("button", { name: "ログイン" }).click();
  await staff.getByRole("heading", { name: "面接一覧" }).waitFor();

  // ------------------------------------------------------------ 録画
  await page.getByRole("button", { name: "録画を開始" }).click();
  await page.getByText("録画中", { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.locator(".qbtn", { hasText: "自己紹介" }).click();

  // ------------------------------------------------------------ ライブ視聴(別の端末から数秒遅れで見る)
  await staff.goto(interviewUrl);
  await staff.locator(".live-panel").waitFor({ timeout: 30_000 });
  const livePlaying = await staff
    .waitForFunction(
      () => {
        const v = document.querySelector(".live-video video");
        if (!v || v.readyState < 2) return false;
        const t = v.currentTime;
        return new Promise((r) => setTimeout(() => r(v.currentTime > t), 1500));
      },
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!livePlaying) errors.push("ライブの映像が再生されない");
  else log("ライブ視聴: 録画中の映像を別の端末で再生できる");
  await staff.getByPlaceholder("いまの場面について(録画の時刻と一緒に残ります)").fill("ライブで見たメモ");
  await staff.getByRole("button", { name: "この場面にメモ" }).click();
  await staff.getByText("この場面にメモを残しました").waitFor();
  await staff.getByPlaceholder("例: 最後に部活のことを聞いてください").fill("最後に部活のことを聞いてください");
  await staff.getByRole("button", { name: "面接室に送る" }).click();
  await page.locator(".room-messages", { hasText: "最後に部活のことを聞いてください" }).waitFor({ timeout: 15_000 });
  await snap(staff, "live-view");
  await snap(page, "studio-room-message");
  await page.locator(".room-messages").getByRole("button", { name: "確認した" }).click();
  log("面接室へのメッセージ: 録画している端末に表示された");

  await page.locator(".qbtn", { hasText: "志望理由" }).click();
  await page.keyboard.press("b");
  await page.waitForTimeout(9000);
  await snap(page, "studio-recording");
  await page.locator(".qbtn", { hasText: "最近がんばったこと" }).click();
  await page.waitForTimeout(12_000);
  await page.getByRole("button", { name: "録画を終了" }).click();
  await page.getByRole("button", { name: "録画を終了する" }).click();
  await page.getByText("送信が完了しました").waitFor({ timeout: 90_000 });
  await snap(page, "upload-done");
  log("録画と送信 OK");

  // ------------------------------------------------------------ 再生・表情の計測
  await page.getByRole("button", { name: "面接の詳細へ(評価の入力)" }).click();
  await page.locator(".review-video video").waitFor({ timeout: 60_000 });
  const videoOk = await page.waitForFunction(
    () => {
      const v = document.querySelector(".review-video video");
      return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 20;
    },
    null,
    { timeout: 30_000 },
  );
  if (!videoOk) errors.push("録画の長さが取得できない");
  const duration = await page.evaluate(() => document.querySelector(".review-video video").duration);
  log(`録画の再生 OK(長さ ${duration.toFixed(1)} 秒、Cues 付き)`);
  // 後半へのシーク
  await page.evaluate(() => {
    const v = document.querySelector(".review-video video");
    v.currentTime = v.duration - 3;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector(".review-video video");
    return v.currentTime > v.duration - 4 && v.readyState >= 2;
  }, null, { timeout: 15_000 });

  await page.getByText("表情の豊かさ(総合)").first().waitFor({ timeout: 30_000 });
  if (images) {
    const smileScenes = await page.locator(".scene-smile").count();
    const gapScenes = await page.locator(".scene-gap").count();
    log(`注目シーン: 笑顔 ${smileScenes} 件 / 顔が映っていない ${gapScenes} 件`);
    if (smileScenes < 1) errors.push("笑顔の注目シーンが検出されていない");
    if (gapScenes < 1) errors.push("顔が映っていない区間が検出されていない");
    const smileRate = await page.locator(".metric-card", { hasText: "笑顔の頻度" }).locator(".metric-value").innerText();
    log(`笑顔の頻度: ${smileRate}`);
    const pct = Number(smileRate.replace(/[^\d.]/g, ""));
    if (!(pct > 10 && pct < 60)) errors.push(`笑顔の頻度が想定外: ${smileRate}(想定 15〜40% 程度)`);
  }
  await page.locator(".scene").first().click();
  await page.getByRole("button", { name: "質問ごと" }).click();
  const segRows = await page.locator(".seg-table tbody tr").count();
  log(`質問ごとの集計: ${segRows} 行`);
  if (segRows < 3) errors.push(`質問ごとの集計が ${segRows} 行しかない`);
  await page.getByRole("button", { name: /^メモ/ }).click();
  await page.getByPlaceholder("気づいたことを書く").fill("ここの受け答えが具体的");
  await page.getByRole("button", { name: "メモを追加" }).click();
  await page.locator(".note-text", { hasText: "ここの受け答えが具体的" }).waitFor();
  await page.waitForTimeout(800);
  await snap(page, "review", true);
  log("確認画面 OK");

  // ------------------------------------------------------------ 評価(管理者)
  await rate(page, [4, 4, 5, 3, 4]);
  await page.locator(".my-eval").getByRole("radio", { name: "合格", exact: true }).click();
  await page.getByLabel("コメント").fill("受け答えが丁寧で、質問の意図をよく理解していた。");
  await page.locator(".my-eval").getByRole("button", { name: "提出する" }).click();
  await page.locator(".modal").getByRole("button", { name: "提出する" }).click();
  await page.getByText(/提出済み/).first().waitFor();
  log("評価(管理者)OK");

  // ライブで見ながら残したメモには、録画の時刻が付いている
  const liveNote = await page.evaluate(async (url) => {
    const id = url.split("/").pop();
    const r = await fetch(`/api/interviews/${id}`, { headers: { "X-Requested-With": "katibito" } });
    const d = await r.json();
    return d.notes.notes.find((n) => n.text === "ライブで見たメモ") ?? null;
  }, interviewUrl);
  if (!liveNote || typeof liveNote.tMs !== "number" || liveNote.tMs < 1000 || liveNote.tMs > 40_000) {
    errors.push(`ライブのメモの時刻が想定外: ${JSON.stringify(liveNote)}`);
  } else log(`ライブのメモ: 録画の ${(liveNote.tMs / 1000).toFixed(1)} 秒の位置に残った`);

  // ------------------------------------------------------------ 評価(面接官): 提出するまで他の評価は見えない
  await staff.goto(BASE);
  await staff.getByText("あなたの対応待ち").waitFor();
  await staff.locator(".todo-row", { hasText: "テスト 太郎" }).click();
  await staff.getByText("自分の評価を提出すると、ほかの評価者の評価とメモが表示されます").waitFor();
  const leaked = await staff.getByText("受け答えが丁寧で").count();
  if (leaked > 0) errors.push("提出前の面接官に管理者の評価が見えている");
  await rate(staff, [3, 4, 3, 4, 3]);
  await staff.locator(".my-eval").getByRole("radio", { name: "保留", exact: true }).click();
  await staff.locator(".my-eval").getByRole("button", { name: "提出する" }).click();
  await staff.locator(".modal").getByRole("button", { name: "提出する" }).click();
  await staff.getByText("受け答えが丁寧で").waitFor();
  await staff.locator(".note-text", { hasText: "ここの受け答えが具体的" }).count();
  await snap(staff, "staff-after-submit", true);
  log("評価(面接官)と非公開ルール OK");

  // ------------------------------------------------------------ 判定
  await page.reload();
  const decideBtn = page.locator(".decision").getByRole("radio", { name: "合格", exact: true });
  await decideBtn.waitFor();
  await decideBtn.click();
  await page.getByLabel("判定の理由(記録用)").fill("2名の評価と録画を確認して決定");
  await page.getByRole("button", { name: "判定を確定する" }).click();
  await page.locator(".modal").getByRole("button", { name: "判定を確定する" }).click();
  await page.locator(".decided .vote-large", { hasText: "合格" }).waitFor();
  await snap(page, "decided", true);
  await page.getByRole("link", { name: "← 面接一覧" }).click();
  await page.locator("table.list").getByText("合格").first().waitFor();
  await snap(page, "list");
  log("判定 OK");

  // ------------------------------------------------------------ 動画の取り込み
  const importFile = images ? makeImportVideo() : null;
  if (importFile) {
    await page.getByRole("button", { name: "面接を登録" }).click();
    await page.getByLabel("表示名").fill("取込 次郎");
    await page.locator(".checks label", { hasText: STAFF.name }).locator("input").check();
    await page.getByRole("button", { name: "登録する" }).click();
    await page.getByRole("heading", { name: "取込 次郎" }).waitFor();
    await page.getByRole("button", { name: "動画を取り込む" }).click();
    await page.getByText("紙の同意書で取得済み").click();
    await page.getByText("面接の録画に同意します").click();
    await page.getByText("録画からの表情の計測に同意します").click();
    await page.getByLabel("ご本人のお名前").fill("取込 次郎");
    await page.getByRole("button", { name: "同意を記録して撮影の準備へ" }).click();
    await page.locator('input[type="file"]').setInputFiles(importFile);
    await page.getByRole("button", { name: "表情を計測して取り込む" }).click();
    await page.getByRole("button", { name: "この顔で計測して取り込む" }).waitFor({ timeout: 90_000 });
    await page.waitForTimeout(500);
    await snap(page, "import-pick");
    await page.getByRole("button", { name: "この顔で計測して取り込む" }).click();
    await page.getByText("取り込みが完了しました").waitFor({ timeout: 180_000 });
    await page.getByRole("button", { name: "面接の詳細へ" }).click();
    await page.getByText("表情の豊かさ(総合)").first().waitFor({ timeout: 60_000 });
    const scenes = await page.locator(".scene-smile").count();
    log(`取り込み: 表情の計測 OK(笑顔の注目シーン ${scenes} 件)`);
    if (scenes < 1) errors.push("取り込んだ動画で笑顔の注目シーンが検出されていない");
    await page.waitForTimeout(800);
    await snap(page, "import-review", true);
  }

  // ------------------------------------------------------------ デモ画面も起動できること
  await page.goto(`${BASE}/demo`);
  await page.getByText("環境チェック").first().waitFor({ timeout: 60_000 });
  log("デモ画面(/demo)OK");
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => undefined);
  server.kill();
  await new Promise((r) => {
    server.once("exit", r);
    setTimeout(r, 5000);
  });
  if (!process.env.E2E_KEEP_DATA) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // 後片付けの失敗は結果に影響させない
    }
  } else log(`データ: ${dataDir}`);
}

if (errors.length > 0) {
  console.error("[e2e] 失敗:");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("[e2e] サーバーログ:\n" + serverLog.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
log(`OK — スクリーンショット: ${outDir}`);
