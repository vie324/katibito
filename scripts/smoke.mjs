// デモ(/demo)のヘッドレススモークテスト(§13 受入基準の自動確認)。運用版の確認は scripts/e2e.mjs。
// - サンプル経路: カメラなしでも サンプル再生 → 結果画面 まで通ること
// - ライブ経路: フェイクカメラ(顔なし)でも チェック無視 → 3問 → 結果(確信度 低)まで落ちないこと
// 実行: npm run build && node scripts/smoke.mjs
// スクリーンショットは smoke-out/ に保存される。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.SMOKE_OUT ?? path.join(root, "smoke-out");
mkdirSync(outDir, { recursive: true });

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

async function waitForServer(url, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`preview server が起動しません: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
});

const errors = [];
let browser = null;

async function launchChromium() {
  const args = ["--autoplay-policy=no-user-gesture-required"];
  try {
    return await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined,
      args,
    });
  } catch (e) {
    // Claude Code のリモート環境などでは同梱 Chromium を直接指す
    if (String(e).includes("Executable doesn't exist") && existsSync("/opt/pw-browsers/chromium")) {
      return chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args });
    }
    throw e;
  }
}

/** ヘッドレスでフェイクデバイスが使えない環境向けに、
 *  getUserMedia を canvas.captureStream + WebAudio の合成ストリームに差し替える。
 *  実際の MediaStream / MediaRecorder / AnalyserNode の経路をそのまま通す。 */
async function installSyntheticMedia(ctx) {
  await ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const c2d = canvas.getContext("2d");
      let t = 0;
      setInterval(() => {
        t++;
        if (!c2d) return;
        c2d.fillStyle = `hsl(${t % 360}, 30%, ${28 + 14 * Math.sin(t / 9)}%)`;
        c2d.fillRect(0, 0, 640, 360);
      }, 33);
      const vstream = canvas.captureStream(30);
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      osc.frequency.value = 150;
      const gain = ac.createGain();
      gain.gain.value = 0;
      setInterval(() => {
        // 発話っぽい振幅変調(約2秒周期で声/沈黙)
        gain.gain.value = Math.sin(Date.now() / 700) > -0.2 ? 0.28 : 0.0;
      }, 60);
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      return new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
  });
}

try {
  await waitForServer(BASE);
  log("preview server 起動");

  browser = await launchChromium();

  // ---------------- サンプル経路(カメラ拒否相当: 権限を与えない) ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`${BASE}/demo`);
    await page.waitForSelector("text=環境チェック", { timeout: 30_000 });
    log("サンプル経路: 環境チェック画面に到達(モデル読み込みOK)");
    await page.screenshot({ path: path.join(outDir, "1-gate-denied.png") });

    await page.click("text=サンプルを再生");
    await page.waitForSelector("text=サンプル再生中", { timeout: 10_000 });
    log("サンプル経路: 再生開始");
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: path.join(outDir, "2-sample-live.png") });

    await page.click("text=結果へ進む");
    await page.waitForSelector("text=根拠テーブル", { timeout: 10_000 });
    const hasProvisional = await page.locator("text=キャリブレーション前").first().isVisible();
    const hasQuadrant = await page.locator(".quadrant-name").isVisible();
    const quadrantText = hasQuadrant ? await page.locator(".quadrant-name").textContent() : "(なし)";
    log(`サンプル経路: 結果画面 OK — 象限=${quadrantText} 暫定注記=${hasProvisional}`);
    if (!hasProvisional) errors.push("結果画面に「キャリブレーション前」の注記が見えていない");
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "3-sample-result.png"), fullPage: true });

    if (consoleErrors.length > 0) {
      errors.push(`サンプル経路の pageerror: ${consoleErrors.join(" / ")}`);
    }
    await ctx.close();
  }

  // ---------------- ライブ経路(合成カメラ、顔なし → チェック無視) ----------------
  {
    const ctx = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      permissions: ["camera", "microphone"],
    });
    await installSyntheticMedia(ctx);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`${BASE}/demo`);
    await page.waitForSelector("text=環境チェック", { timeout: 30_000 });
    await page.waitForTimeout(4_000); // サンプリングを回す
    await page.screenshot({ path: path.join(outDir, "4-gate-fake-camera.png") });

    const skip = page.getByRole("button", { name: "チェックを無視して開始" });
    await skip.click();
    await page.waitForSelector("text=設問 1/3", { timeout: 10_000 });
    log("ライブ経路: 設問1 開始");
    await page.waitForTimeout(4_000); // インターバル + 数秒の計測
    await page.screenshot({ path: path.join(outDir, "5-live-running.png") });

    for (let i = 0; i < 3; i++) {
      const label = i < 2 ? "次の設問へ" : "回答を終了する";
      const btn = page.locator(`button:has-text("${label}")`);
      await btn.waitFor({ state: "visible", timeout: 10_000 });
      // インターバル中は disabled なので有効化を待つ
      await page.waitForFunction(
        (text) => {
          const el = [...document.querySelectorAll("button")].find((b) =>
            b.textContent?.includes(text),
          );
          return el && !el.disabled;
        },
        label,
        { timeout: 10_000 },
      );
      await page.waitForTimeout(1_500);
      await btn.click();
    }

    await page.waitForSelector("text=根拠テーブル", { timeout: 15_000 });
    const lowConf = await page.locator("text=判定に足るデータが取れていません").isVisible();
    log(`ライブ経路: 結果画面 OK — 低確信度メッセージ=${lowConf}`);
    if (!lowConf) errors.push("顔なし・チェック無視のとき低確信度メッセージが出ていない");
    await page.screenshot({ path: path.join(outDir, "6-live-result.png"), fullPage: true });

    if (consoleErrors.length > 0) {
      errors.push(`ライブ経路の pageerror: ${consoleErrors.join(" / ")}`);
    }
    await ctx.close();
  }
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
}

if (errors.length > 0) {
  console.error("[smoke] 失敗:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
log(`OK — スクリーンショット: ${outDir}`);
