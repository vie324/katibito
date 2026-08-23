// 接し方ガイド(§7)。デフォルトはテンプレート生成。
// VITE_ANTHROPIC_API_KEY が設定されている場合のみ Claude API を試す。
// キー未設定・タイムアウト・失敗・禁止表現の混入、どの場合も必ずテンプレートで返す。

import {
  FEATURE_NOTES,
  FORBIDDEN_SUBSTRINGS,
  GUIDE_API,
  GUIDE_SYSTEM_PROMPT,
  QUADRANT_GUIDES,
} from "../config/guides";
import { FEATURE_META, QUADRANTS, type QuadrantKey, type ScoredFeatureKey } from "../config/scoring";
import type { Contribution, ScoreResult } from "./scoring";

export type GuideResult = {
  text: string;
  source: "template" | "api";
};

/** 禁止表現(§7)を含むか。含む場合は最初にヒットした語を返す。 */
export function containsForbidden(text: string): string | null {
  for (const word of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(word)) return word;
  }
  return null;
}

/** 寄与度の大きい順(重み × 中央からの距離)に上位の特徴量を返す。 */
export function topContributors(score: ScoreResult, n: number): Contribution[] {
  const all = [...score.assertiveness.contributions, ...score.expressiveness.contributions];
  return all
    .filter((c) => c.excludedReason === null && c.norm !== null)
    .sort(
      (a, b) =>
        b.weightUsed * Math.abs((b.norm ?? 50) - 50) - a.weightUsed * Math.abs((a.norm ?? 50) - 50),
    )
    .slice(0, n);
}

/** テンプレート生成: 象限の基本文 + 上位2特徴量の補足(§7)。 */
export function buildTemplateGuide(quadrant: QuadrantKey, score: ScoreResult): string {
  const lines = [...QUADRANT_GUIDES[quadrant]];
  for (const c of topContributors(score, 2)) {
    const note = FEATURE_NOTES[c.key];
    if (!note || c.norm === null) continue;
    lines.push(c.norm >= 50 ? note.high : note.low);
  }
  return lines.join("\n");
}

/**
 * ガイド生成の入口。API はあくまで上積みで、テンプレートが常に土台(§7:
 * デモ会場でのキー不備は致命傷 — キーが無くても必ず動く)。
 */
export async function generateGuide(
  quadrant: QuadrantKey,
  score: ScoreResult,
): Promise<GuideResult> {
  const template = buildTemplateGuide(quadrant, score);
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined;
  if (!apiKey) return { text: template, source: "template" };

  try {
    const text = await callClaude(apiKey, quadrant, score);
    if (text && text.length >= 40 && containsForbidden(text) === null) {
      return { text, source: "api" };
    }
  } catch (e) {
    console.warn("[guide] Claude API での生成に失敗。テンプレートを使います", e);
  }
  return { text: template, source: "template" };
}

async function callClaude(
  apiKey: string,
  quadrant: QuadrantKey,
  score: ScoreResult,
): Promise<string | null> {
  // 動的 import: キー未設定の構成では SDK をロードしない
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: GUIDE_API.TIMEOUT_MS,
  });

  const observations = topContributors(score, 4)
    .map((c) => {
      const meta = FEATURE_META[c.key as ScoredFeatureKey];
      const side = (c.norm ?? 50) >= 50 ? "高い側" : "低い側";
      return `- ${meta.label}: 正規化値 ${Math.round(c.norm ?? 0)}(${side})`;
    })
    .join("\n");

  const userPrompt = [
    `観測された象限: ${QUADRANTS[quadrant].name}`,
    `主張性: ${Math.round(score.assertiveness.score ?? 0)} / 100`,
    `感情表出性: ${Math.round(score.expressiveness.score ?? 0)} / 100`,
    "主な観測傾向:",
    observations,
    "",
    "この観測に合わせた仕事上の接し方ガイドを3〜4文で書いてください。",
  ].join("\n");

  const response = await client.beta.messages.create({
    model: GUIDE_API.MODEL,
    max_tokens: GUIDE_API.MAX_TOKENS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: GUIDE_API.EFFORT },
    system: GUIDE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.stop_reason === "refusal") return null;
  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}
