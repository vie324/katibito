// モデルと WASM をローカル同梱する(設計書 §3)。実行時に外部通信を発生させないための準備。
// - public/wasm/            ← node_modules/@mediapipe/tasks-vision/wasm からコピー(毎回同期)
// - public/models/face_landmarker.task ← 無ければ GCS からダウンロード(リポジトリにコミット済みなら何もしない)
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_DEST = path.join(root, "public", "models", "face_landmarker.task");
const WASM_DEST = path.join(root, "public", "wasm");

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function vendorWasm() {
  // exports フィールドの制約で require.resolve が使えないため直接パス参照
  const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  if (!(await exists(path.join(wasmSrc, "vision_wasm_internal.wasm")))) {
    throw new Error(`${wasmSrc} が見つかりません`);
  }
  await mkdir(WASM_DEST, { recursive: true });
  await cp(wasmSrc, WASM_DEST, { recursive: true });
  console.log(`[vendor] wasm: ${wasmSrc} -> public/wasm/`);
}

async function vendorModel() {
  if (await exists(MODEL_DEST)) {
    console.log("[vendor] model: public/models/face_landmarker.task は既にあります");
    return;
  }
  await mkdir(path.dirname(MODEL_DEST), { recursive: true });
  console.log(`[vendor] model: ダウンロード中 ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_DEST, buf);
  console.log(`[vendor] model: ${(buf.length / 1e6).toFixed(1)}MB を保存しました`);
}

try {
  await vendorWasm();
} catch (e) {
  console.error("[vendor] wasm のコピーに失敗。npm install 済みか確認してください:", e.message);
  process.exitCode = 1;
}
try {
  await vendorModel();
} catch (e) {
  // ネットワーク遮断環境ではモデル未取得のまま続行できる(アプリ側はサンプル再生モードへ誘導する)
  console.error("[vendor] モデルのダウンロードに失敗:", e.message);
  console.error("[vendor] 手動配置: face_landmarker.task(float16) を public/models/ に置いてください");
}
