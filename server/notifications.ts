// 業務イベントの通知文。候補者の表示名とリンクだけを載せる(数値や評価内容は載せない)。

import { VOTE_LABEL } from "../src/shared/status";
import type { Decision, Interview, RecordingMeta } from "../src/shared/types";
import type { AppContext } from "./context";
import { sendWebhook } from "./notify";

function link(ctx: AppContext, iv: Interview): string {
  const base = ctx.config.appUrl ?? ctx.lastOrigin;
  return base ? `${base}/interviews/${iv.id}` : "";
}

function minutes(ms: number | null): string {
  if (!ms) return "";
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `(約${m}分)` : "(1分未満)";
}

export async function notifyRecordingReady(ctx: AppContext, iv: Interview, rec: RecordingMeta): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの録画が共有されました${minutes(rec.durationMs)}。\n${link(ctx, iv)}`,
  );
}

export async function notifyEvaluationSubmitted(
  ctx: AppContext,
  iv: Interview,
  userName: string,
  submitted: number,
  expected: number,
): Promise<void> {
  const progress = expected > 0 ? `(${submitted}/${expected}人)` : "";
  const all = expected > 0 && submitted >= expected ? "\n面接官全員の評価がそろいました。判定をお願いします。" : "";
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${userName} さんが ${iv.candidate.displayName} さんの評価を提出しました${progress}。${all}\n${link(ctx, iv)}`,
  );
}

export async function notifyDecision(ctx: AppContext, iv: Interview, d: Decision): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの判定が「${VOTE_LABEL[d.result]}」に確定しました(${d.decidedByName})。\n${link(ctx, iv)}`,
  );
}
