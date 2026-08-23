// public/sample-session.json を生成する(§9 サンプル再生モード / 実装順序 Step 3)。
// SessionRecorder の本番コードパス(ライブEMA・トレイル・集計)をそのまま通す。
// 実行: npm run generate:sample

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERSTITIAL_MS, QUESTIONS } from "../src/config/questions";
import { BLEND_COUNT } from "../src/engine/blendshapeNames";
import { SessionRecorder } from "../src/engine/sessionStore";
import { mulberry32, PROFILES, synthesizeQuestion } from "./lib/synth";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const rng = mulberry32(20260823);
const recorder = new SessionRecorder(
  {
    passed: true,
    skipped: false,
    results: { face: true, size: true, pose: true, light: true, mic: true },
    speechRecognitionUsed: true,
  },
  true,
  "sample-generator",
);

let t = 3000;
for (const q of QUESTIONS) {
  const sq = synthesizeQuestion(PROFILES.balanced, t, q.durationMs, rng);
  recorder.beginQuestion(q, sq.shownAtMs);
  let segIdx = 0;
  for (let i = 0; i < sq.frames.count; i++) {
    const ft = sq.frames.t[i];
    const f0 = sq.frames.f0[i];
    recorder.pushFrame(
      ft,
      sq.frames.detected[i] === 1,
      sq.frames.blend.subarray(i * BLEND_COUNT, (i + 1) * BLEND_COUNT),
      sq.frames.yaw[i],
      sq.frames.pitch[i],
      sq.frames.roll[i],
      sq.frames.rms[i],
      Number.isNaN(f0) ? null : f0,
      sq.frames.voiced[i] === 1,
    );
    while (segIdx < sq.segments.length && sq.segments[segIdx].tMs <= ft) {
      recorder.addFinalSegment(sq.segments[segIdx].text, sq.segments[segIdx].tMs);
      segIdx++;
    }
    recorder.liveTick(ft);
  }
  while (segIdx < sq.segments.length) {
    recorder.addFinalSegment(sq.segments[segIdx].text, sq.segments[segIdx].tMs);
    segIdx++;
  }
  recorder.endQuestion(sq.endAtMs);
  t = sq.endAtMs + INTERSTITIAL_MS;
}

const result = recorder.finish("2026-08-23T09:00:00.000Z");
// 再生成のたびに差分が出ないよう ID を固定する
result.replay.session.sessionId = "sample-00000000-0000-4000-8000-000000000000";

const out = path.join(root, "public", "sample-session.json");
writeFileSync(out, JSON.stringify(result.replay));

const agg = result.session.aggregate;
console.log(`[sample] ${out}`);
console.log(
  `[sample] A=${agg.assertiveness} E=${agg.expressiveness} quadrant=${agg.quadrant} confidence=${agg.confidence}`,
);
console.log(`[sample] size=${(JSON.stringify(result.replay).length / 1024).toFixed(0)}KB`);
