// 表情指標の表示用メタデータ(画面・CSV出力で共通)。
// 文言は「何を測ったか」だけを書き、内面や性格の解釈は書かない。

import type { ScoredFeatureKey } from "../config/scoring";
import type { ExpressionMetrics } from "./expression";

export type MetricKey = keyof ExpressionMetrics;

export type MetricMeta = {
  label: string;
  unit: string;
  /** percent: 0〜1 を % 表示 */
  kind: "percent" | "number";
  digits: number;
  description: string;
  /** 参考値(総合値に含めない・解釈に注意) */
  reference: boolean;
  /** 暫定基準の帯域(NORMS)がある指標 */
  norm: ScoredFeatureKey | null;
};

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  expressiveness: {
    label: "表情の豊かさ(総合)",
    unit: "/100",
    kind: "number",
    digits: 0,
    description:
      "笑顔の頻度・強さ、眉の動き、表情の変化、うなずきを暫定基準で0〜100にまとめた値です。",
    reference: false,
    norm: null,
  },
  smileRate: {
    label: "笑顔の頻度",
    unit: "%",
    kind: "percent",
    digits: 1,
    description: "顔が映っていた時間のうち、口角が上がっていた時間の割合です。",
    reference: false,
    norm: "smileRate",
  },
  smilePerMin: {
    label: "笑顔の回数",
    unit: "回/分",
    kind: "number",
    digits: 1,
    description: "0.4秒以上続いた笑顔の回数を、1分あたりに換算した値です。",
    reference: false,
    norm: null,
  },
  smileIntensity: {
    label: "笑顔の大きさ",
    unit: "",
    kind: "number",
    digits: 2,
    description: "口角の上がり方が大きかった場面(上位10%)の平均です(0〜1)。",
    reference: false,
    norm: "smileIntensity",
  },
  browActivity: {
    label: "眉の動き",
    unit: "%",
    kind: "percent",
    digits: 1,
    description: "眉が上がっていた時間の割合です。話すときの表情の動きの目安になります。",
    reference: false,
    norm: "browActivity",
  },
  expressionVariance: {
    label: "表情の変化",
    unit: "",
    kind: "number",
    digits: 3,
    description: "口元・頬・眉の動きの大きさのばらつきです。大きいほど表情がよく動いています。",
    reference: false,
    norm: "expressionVariance",
  },
  nodRate: {
    label: "うなずき",
    unit: "回/分",
    kind: "number",
    digits: 1,
    description: "頭の縦の小刻みな動きを数えた目安です。",
    reference: false,
    norm: "nodRate",
  },
  lookDownRatio: {
    label: "下を向いていた割合",
    unit: "%",
    kind: "percent",
    digits: 1,
    description: "顔の向きが、その人のふだんの向きより15°以上下だった時間の割合です。",
    reference: true,
    norm: null,
  },
  blinkRate: {
    label: "まばたき",
    unit: "回/分",
    kind: "number",
    digits: 1,
    description: "1分あたりのまばたきの回数です。撮影条件で取りこぼしが出やすい参考値です。",
    reference: true,
    norm: null,
  },
  duchenneRatio: {
    label: "頬の上がりを伴う笑顔",
    unit: "%",
    kind: "percent",
    digits: 0,
    description: "笑顔のうち、頬の上がりも伴っていた割合です。確度の低い参考値です。",
    reference: true,
    norm: null,
  },
  poseStability: {
    label: "頭の向きの変動",
    unit: "°",
    kind: "number",
    digits: 1,
    description: "顔の左右の向き・傾きのばらつきです。",
    reference: true,
    norm: null,
  },
  faceDetectRate: {
    label: "顔の計測率",
    unit: "%",
    kind: "percent",
    digits: 0,
    description: "録画のうち、候補者の顔を計測できた時間の割合です。低いと数値の信頼度が下がります。",
    reference: false,
    norm: null,
  },
  detectedSec: {
    label: "計測できた時間",
    unit: "秒",
    kind: "number",
    digits: 0,
    description: "候補者の顔を計測できた合計時間です。",
    reference: false,
    norm: null,
  },
};

/** 概要カードに出す順 */
export const PRIMARY_METRICS: MetricKey[] = [
  "smileRate",
  "smilePerMin",
  "smileIntensity",
  "browActivity",
  "expressionVariance",
  "nodRate",
];

export const REFERENCE_METRICS: MetricKey[] = [
  "lookDownRatio",
  "blinkRate",
  "duchenneRatio",
  "poseStability",
];

/** 過去の面接との比較・CSV に出す指標 */
export const COMPARABLE_METRICS: MetricKey[] = [
  "expressiveness",
  ...PRIMARY_METRICS,
  ...REFERENCE_METRICS,
];

export function formatMetric(key: MetricKey, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const m = METRIC_META[key];
  const value = m.kind === "percent" ? v * 100 : v;
  return value.toFixed(m.digits);
}

export const QUALITY_LABEL: Record<"high" | "mid" | "low", string> = {
  high: "高",
  mid: "中",
  low: "低",
};
