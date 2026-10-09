// 顔ランドマークモデルの読み込み(運用版で共有する1インスタンス)。

import { INTERVIEW_ANALYSIS } from "../../config/scoring";
import { FaceEngine } from "../../engine/faceEngine";

type Progress = { stage: string; fraction: number };

let enginePromise: Promise<FaceEngine> | null = null;
let lastProgress: Progress = { stage: "準備中", fraction: 0 };
const listeners = new Set<(p: Progress) => void>();

export function loadFaceEngine(onProgress?: (p: Progress) => void): Promise<FaceEngine> {
  if (onProgress) {
    listeners.add(onProgress);
    onProgress(lastProgress);
  }
  if (!enginePromise) {
    enginePromise = FaceEngine.create(
      (stage, fraction) => {
        lastProgress = { stage, fraction };
        for (const fn of listeners) fn(lastProgress);
      },
      { numFaces: INTERVIEW_ANALYSIS.MAX_FACES },
    );
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  const p = enginePromise;
  if (onProgress) void p.finally(() => listeners.delete(onProgress)).catch(() => undefined);
  return p;
}
