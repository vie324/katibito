// tests/fixtures/chrome-recording.webm を作り直す(Chromium の MediaRecorder の実出力)。
// 中身は色の変わる画面と正弦波だけ(人物は映らない)。
// 実行: node scripts/fixtures/record-webm.mjs [秒数] [alpha]
// alpha を付けると透過ありの canvas を録る(Chrome は映像を BlockGroup で書く)

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const seconds = Number(process.argv[2] ?? 4);
const alpha = process.argv[3] === "alpha";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.goto("about:blank");
const bytes = await page.evaluate(async ([sec, withAlpha]) => {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const c = canvas.getContext("2d", { alpha: withAlpha });
  let t = 0;
  const iv = setInterval(() => {
    t++;
    c.fillStyle = `hsl(${(t * 7) % 360},50%,45%)`;
    c.fillRect(0, 0, 160, 90);
    c.fillStyle = "#fff";
    c.font = "24px sans-serif";
    c.fillText(String(t), 10, 50);
  }, 33);
  const vs = canvas.captureStream(30);
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, {
    mimeType: "video/webm;codecs=vp8,opus",
    videoBitsPerSecond: 150_000,
    audioBitsPerSecond: 32_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(1000);
  await new Promise((r) => setTimeout(r, sec * 1000));
  await new Promise((r) => {
    rec.onstop = r;
    rec.stop();
  });
  clearInterval(iv);
  const blob = new Blob(chunks);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}, [seconds, alpha]);
await browser.close();

const out = path.join(root, "tests", "fixtures", alpha ? "chrome-recording-alpha.webm" : "chrome-recording.webm");
writeFileSync(out, Uint8Array.from(bytes));
console.log(`[fixture] ${out} (${bytes.length} bytes)`);
