// MediaPipe FaceLandmarker のラッパ(§5.2 / §5.3)。
// - モデル・WASM はローカル同梱(/public)。実行時に外部通信しない
// - GPU delegate 失敗時は CPU にフォールバック(§9)
// - detectForVideo は video.currentTime ベースのタイムスタンプで呼び、
//   同一タイムスタンプでは呼ばない(§9-3)

import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { ASSET_PATHS, FLAGS } from "../config/flags";
import { SIGNS } from "../config/scoring";
import { BLEND_COUNT, blendIndexByName } from "./blendshapeNames";
import { matrixToEulerDeg } from "./dsp";

export type FaceFrame = {
  detected: boolean;
  /** 正準順の blendshape スコア。内部バッファを再利用しているので保持する側でコピーすること */
  blend: Float32Array;
  yaw: number;
  pitch: number;
  roll: number;
  landmarks: NormalizedLandmark[] | null;
  /** 顔バウンディングボックス(正規化座標)。未検出時は 0 */
  box: { x0: number; y0: number; x1: number; y1: number; h: number };
};

export type FaceProgress = (stage: string, fraction: number) => void;

export class FaceEngine {
  readonly delegate: "GPU" | "CPU";
  private readonly landmarker: FaceLandmarker;

  /** モデル出力順 → 正準順のマップ。初回検出時に categoryName から構築(付録B-2) */
  private modelToCanonical: Int32Array | null = null;
  private readonly blendOut = new Float32Array(BLEND_COUNT);
  private readonly frame: FaceFrame = {
    detected: false,
    blend: this.blendOut,
    yaw: 0,
    pitch: 0,
    roll: 0,
    landmarks: null,
    box: { x0: 0, y0: 0, x1: 0, y1: 0, h: 0 },
  };

  private lastRawMs = -1;
  private lastSubmittedMs = -1;

  private constructor(landmarker: FaceLandmarker, delegate: "GPU" | "CPU") {
    this.landmarker = landmarker;
    this.delegate = delegate;
  }

  static async create(onProgress: FaceProgress): Promise<FaceEngine> {
    onProgress("WASM を読み込み中", 0.05);
    const fileset = await FilesetResolver.forVisionTasks(ASSET_PATHS.WASM_DIR);

    onProgress("顔ランドマークモデルを読み込み中", 0.15);
    const modelBuffer = await fetchWithProgress(ASSET_PATHS.FACE_MODEL, (frac) =>
      onProgress("顔ランドマークモデルを読み込み中", 0.15 + frac * 0.65),
    );

    const build = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer), delegate },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });

    onProgress("推論エンジンを初期化中", 0.85);
    if (FLAGS.ENABLE_GPU_DELEGATE) {
      try {
        const lm = await build("GPU");
        onProgress("準備完了", 1);
        return new FaceEngine(lm, "GPU");
      } catch (e) {
        console.warn("[faceEngine] GPU delegate に失敗。CPU にフォールバックします", e);
      }
    }
    const lm = await build("CPU");
    onProgress("準備完了", 1);
    return new FaceEngine(lm, "CPU");
  }

  /**
   * 新しい映像フレームがあれば検出して返す。フレームが進んでいなければ null。
   * 返り値の blend / frame オブジェクトは再利用される。
   */
  detect(video: HTMLVideoElement): FaceFrame | null {
    const rawMs = Math.round(video.currentTime * 1000);
    if (rawMs === this.lastRawMs || video.readyState < 2) return null;
    this.lastRawMs = rawMs;
    // 別の video 要素に切り替わった直後などに時刻が巻き戻っても単調増加を保つ
    const ts = rawMs > this.lastSubmittedMs ? rawMs : this.lastSubmittedMs + 1;
    this.lastSubmittedMs = ts;

    const result = this.landmarker.detectForVideo(video, ts);
    const frame = this.frame;

    const categories = result.faceBlendshapes?.[0]?.categories;
    const landmarks = result.faceLandmarks?.[0];
    if (!categories || !landmarks) {
      frame.detected = false;
      frame.landmarks = null;
      return frame;
    }

    if (this.modelToCanonical === null) {
      this.modelToCanonical = new Int32Array(categories.length);
      const names: Record<string, number> = {};
      for (let i = 0; i < categories.length; i++) {
        const name = categories[i].categoryName;
        const idx = blendIndexByName(name);
        this.modelToCanonical[i] = idx === undefined ? -1 : idx;
        names[name] = i;
        if (idx === undefined) {
          console.warn(`[faceEngine] 未知の blendshape 名: ${name}`);
        }
      }
      // 付録B-2: 実際の名前を全件コンソールに出して確認できるようにする
      console.info("[faceEngine] blendshape names (model order):", names);
    }

    this.blendOut.fill(0);
    const map = this.modelToCanonical;
    for (let i = 0; i < categories.length; i++) {
      const ci = map[i];
      if (ci >= 0) this.blendOut[ci] = categories[i].score;
    }

    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    if (matrix) {
      const e = matrixToEulerDeg(matrix);
      frame.yaw = e.yaw * SIGNS.YAW_SIGN;
      frame.pitch = e.pitch * SIGNS.PITCH_SIGN;
      frame.roll = e.roll * SIGNS.ROLL_SIGN;
    }

    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const p of landmarks) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    frame.box.x0 = minX;
    frame.box.y0 = minY;
    frame.box.x1 = maxX;
    frame.box.y1 = maxY;
    frame.box.h = Math.max(0, maxY - minY);

    frame.detected = true;
    frame.landmarks = landmarks;
    return frame;
  }

  close(): void {
    this.landmarker.close();
  }
}

async function fetchWithProgress(
  url: string,
  onFraction: (frac: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`モデルの読み込みに失敗しました (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total > 0) onFraction(Math.min(1, loaded / total));
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
