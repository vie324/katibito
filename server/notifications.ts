// 業務イベントの通知(Webhook とメール)。候補者の表示名・日時・リンクだけを載せる(評価の内容や数値は載せない)。
// メールは、その面接を見られる人のうち、お知らせを受け取る設定にしている人にだけ送る。

import { submittedEvaluations, VOTE_LABEL } from "../src/shared/status";
import type { Decision, Interview, NotifyPrefs, RecordingMeta } from "../src/shared/types";
import { canView } from "./access";
import type { AppContext } from "./context";
import { sendMailToUsers } from "./mail";
import { sendWebhook } from "./notify";
import type { UserRecord } from "./store";

type IvLike = Pick<Interview, "id" | "candidate" | "round" | "scheduledAt" | "location" | "interviewerIds" | "createdBy">;

export function interviewLink(ctx: AppContext, iv: Pick<Interview, "id">): string {
  const base = ctx.config.appUrl ?? ctx.lastOrigin;
  return base ? `${base}/interviews/${iv.id}` : "";
}

function minutes(ms: number | null): string {
  if (!ms) return "";
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `(約${m}分)` : "(1分未満)";
}

/** 10/12(月) 10:00 */
export function jstShort(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 「山田 太郎 さん(一次面接)」 */
export function whoLabel(iv: IvLike): string {
  return `${iv.candidate.displayName} さん${iv.round ? `(${iv.round})` : ""}`;
}

/** 面接の要点(日時・場所・リンク)をメールの本文用に */
export function interviewLines(ctx: AppContext, iv: IvLike): string {
  const lines = [];
  if (iv.scheduledAt) lines.push(`面接日時: ${jstShort(iv.scheduledAt)}`);
  if (iv.location) lines.push(`場所: ${iv.location}`);
  const link = interviewLink(ctx, iv);
  if (link) lines.push(link);
  return lines.join("\n");
}

/** お知らせのメールを受け取る人: 有効・メールあり・設定がオン・その面接を見られる */
export function mailRecipients(
  ctx: AppContext,
  iv: IvLike,
  pref: keyof NotifyPrefs,
  filter: (u: UserRecord) => boolean = () => true,
): UserRecord[] {
  return [...ctx.store.users.values()].filter((u) => !u.disabled && u.email && u.notify[pref] && canView(ctx, u, iv) && filter(u));
}

export async function notifyRecordingReady(ctx: AppContext, iv: Interview, rec: RecordingMeta): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの録画が共有されました${minutes(rec.durationMs)}。\n${interviewLink(ctx, iv)}`,
  );
  // 担当の面接官のうち、まだ評価を提出していない人に
  const done = new Set(submittedEvaluations(ctx.store.evaluationsOf(iv.id)).map((e) => e.userId));
  const to = mailRecipients(ctx, iv, "evaluation", (u) => iv.interviewerIds.includes(u.id) && !done.has(u.id));
  await sendMailToUsers(
    ctx,
    to,
    `${whoLabel(iv)}の録画が共有されました(評価のお願い)`,
    `${whoLabel(iv)}の面接の録画が共有されました${minutes(rec.durationMs)}。\n録画を確認して、評価を入力・提出してください。\n\n${interviewLines(ctx, iv)}`,
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
  const complete = expected > 0 && submitted >= expected;
  const all = complete ? "\n面接官全員の評価がそろいました。判定をお願いします。" : "";
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${userName} さんが ${iv.candidate.displayName} さんの評価を提出しました${progress}。${all}\n${interviewLink(ctx, iv)}`,
  );
  if (!complete) return;
  const to = mailRecipients(ctx, iv, "admin", (u) => u.role === "admin");
  await sendMailToUsers(
    ctx,
    to,
    `${whoLabel(iv)}の評価がそろいました(判定をお願いします)`,
    `${whoLabel(iv)}の面接官全員(${expected}人)の評価がそろいました。\n評価と録画を確認して、判定をお願いします。\n\n${interviewLines(ctx, iv)}`,
  );
}

export async function notifyDecision(ctx: AppContext, iv: IvLike, d: Decision): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの判定が「${VOTE_LABEL[d.result]}」に確定しました(${d.decidedByName})。\n${interviewLink(ctx, iv)}`,
  );
  const to = mailRecipients(ctx, iv, "evaluation", (u) => iv.interviewerIds.includes(u.id) && u.id !== d.decidedBy);
  await sendMailToUsers(
    ctx,
    to,
    `${whoLabel(iv)}の判定が確定しました`,
    `${whoLabel(iv)}の判定が「${VOTE_LABEL[d.result]}」に確定しました(${d.decidedByName})。\n\n${interviewLines(ctx, iv)}`,
  );
}

export async function notifyLiveStarted(ctx: AppContext, iv: Interview, startedBy: string): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの面接の録画が始まりました。ライブ(数秒遅れ)で見られます。\n${interviewLink(ctx, iv)}`,
  );
  // 録画している本人には送らない
  const to = mailRecipients(ctx, iv, "live", (u) => u.id !== startedBy);
  await sendMailToUsers(
    ctx,
    to,
    `${whoLabel(iv)}の面接が始まりました(ライブで見られます)`,
    `${whoLabel(iv)}の面接の録画が始まりました。\n下のリンクから、数秒遅れのライブで見られます。見ながらメモを残したり、面接室にメッセージを送ったりできます。\n\n${interviewLines(ctx, iv)}`,
  );
}

export async function notifyConsentOnline(ctx: AppContext, iv: Interview, recording: boolean, linkCreatedBy: string): Promise<void> {
  await sendWebhook(
    ctx.store.settings.webhookUrl,
    `【面接記録】${iv.candidate.displayName} さんの同意がオンラインで届きました(録画${recording ? "に同意" : "には同意なし"})。\n${interviewLink(ctx, iv)}`,
  );
  // 管理者と、リンクを送った人に
  const to = [...ctx.store.users.values()].filter(
    (u) =>
      !u.disabled &&
      u.email &&
      canView(ctx, u, iv) &&
      ((u.role === "admin" && u.notify.admin) || (u.id === linkCreatedBy && u.notify.evaluation)),
  );
  await sendMailToUsers(
    ctx,
    to,
    `${whoLabel(iv)}の同意がオンラインで届きました`,
    `${whoLabel(iv)}について、送った同意のリンクから回答が届きました。\n録画: ${recording ? "同意する" : "同意しない"}\n\n当日の撮影の前に、口頭でも確認してください。\n\n${interviewLines(ctx, iv)}`,
  );
}
