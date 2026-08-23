// MediaPipe FaceLandmarker が出力する 52 blendshape の正準名(ARKit準拠 + _neutral)。
// 実行時は faceEngine が categoryName を見てこの並びにマップし直すので、
// モデルのバージョンで出力順が変わっても特徴量側のインデックスは崩れない(付録B-2)。

export const CANONICAL_BLENDSHAPES = [
  "_neutral",
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "mouthClose",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
] as const;

export const BLEND_COUNT = CANONICAL_BLENDSHAPES.length; // 52

const index = new Map<string, number>(
  CANONICAL_BLENDSHAPES.map((n, i) => [n, i]),
);

export function blendIndex(name: (typeof CANONICAL_BLENDSHAPES)[number]): number {
  return index.get(name)!;
}

export function blendIndexByName(name: string): number | undefined {
  return index.get(name);
}

// features.ts が使うチャネルの固定インデックス
export const BS = {
  smileL: blendIndex("mouthSmileLeft"),
  smileR: blendIndex("mouthSmileRight"),
  cheekL: blendIndex("cheekSquintLeft"),
  cheekR: blendIndex("cheekSquintRight"),
  browInner: blendIndex("browInnerUp"),
  browOuterL: blendIndex("browOuterUpLeft"),
  browOuterR: blendIndex("browOuterUpRight"),
  blinkL: blendIndex("eyeBlinkLeft"),
  blinkR: blendIndex("eyeBlinkRight"),
} as const;
