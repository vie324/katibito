// 時間がたってから送るメールのお知らせ: 評価の催促と、前日のお知らせ。
// 定期的(15分ごと)に確かめ、1人1通にまとめて送る。送ったものは notify-log.json に記録して二重に送らない。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { submittedEvaluations } from "../src/shared/status";
import type { Interview } from "../src/shared/types";
import type { AppContext } from "./context";
import { mailEnabled, sendMail } from "./mail";
import { interviewLink, jstShort, mailRecipients, whoLabel } from "./notifications";
import { writeJsonAtomic, type UserRecord } from "./store";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 評価の催促は1つの面接につき1人3回まで、24時間おき */
export const MAX_EVALUATION_REMINDERS = 3;
const LOG_FILE = "notify-log.json";
const KEEP_MS = 120 * DAY;

type LogEntry = { count: number; lastAt: string };
type Log = Record<string, LogEntry>;

const logs = new WeakMap<AppContext, Log>();
const running = new WeakSet<AppContext>();

async function loadLog(ctx: AppContext): Promise<Log> {
  let log = logs.get(ctx);
  if (log) return log;
  try {
    log = JSON.parse(await readFile(path.join(ctx.config.dataDir, LOG_FILE), "utf8")) as Log;
  } catch {
    log = {};
  }
  logs.set(ctx, log);
  return log;
}

async function saveLog(ctx: AppContext, log: Log, now: number): Promise<void> {
  for (const [k, e] of Object.entries(log)) if (now - Date.parse(e.lastAt) > KEEP_MS) delete log[k];
  await writeJsonAtomic(path.join(ctx.config.dataDir, LOG_FILE), log);
}

/** 評価の材料がそろった時刻(サーバーの時計): 録画の終わり。録画しない面接は、同意の記録と予定日時の遅い方 */
function sharedAt(iv: Interview): number | null {
  const ready = iv.recordings.filter((r) => r.status === "ready" || r.status === "purged");
  if (ready.length > 0) return Math.max(...ready.map((r) => Date.parse(r.createdAt) + (r.durationMs ?? 0)));
  if (iv.recordingDeclined && iv.consent) {
    return Math.max(Date.parse(iv.consent.obtainedAt), iv.scheduledAt ? Date.parse(iv.scheduledAt) : 0);
  }
  return null;
}

const jstDate = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
const jstHour = (ms: number) => new Date(ms + 9 * HOUR).getUTCHours();

function itemLines(ctx: AppContext, iv: Interview, withTime: "date" | "time"): string {
  const when = iv.scheduledAt
    ? withTime === "time"
      ? new Date(iv.scheduledAt).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })
      : jstShort(iv.scheduledAt)
    : "";
  const head = `・${when ? `${when} ` : ""}${whoLabel(iv)}${iv.location ? ` ${iv.location}` : ""}`;
  const link = interviewLink(ctx, iv);
  return link ? `${head}\n  ${link}` : head;
}

export type ReminderResult = { evaluation: number; dayBefore: number };

export async function runReminders(ctx: AppContext, now = Date.now()): Promise<ReminderResult> {
  const result: ReminderResult = { evaluation: 0, dayBefore: 0 };
  const settings = ctx.store.settings.reminders;
  if (!settings.enabled || !mailEnabled(ctx) || running.has(ctx)) return result;
  running.add(ctx);
  try {
    const log = await loadLog(ctx);
    let changed = false;
    const ivs = [...ctx.store.interviews.values()].sort((a, b) =>
      (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt),
    );

    // ------------------------------------------------------------ 評価の催促
    const evalDue = new Map<UserRecord, { iv: Interview; key: string }[]>();
    for (const iv of ivs) {
      if (iv.decision) continue;
      const at = sharedAt(iv);
      if (at === null || now - at < settings.evaluationAfterHours * HOUR) continue;
      const done = new Set(submittedEvaluations(ctx.store.evaluationsOf(iv.id)).map((e) => e.userId));
      for (const u of mailRecipients(ctx, iv, "evaluation", (x) => iv.interviewerIds.includes(x.id) && !done.has(x.id))) {
        const key = `eval:${iv.id}:${u.id}`;
        const e = log[key];
        // 15分ごとの確認のずれで1日おきにならないよう、少し早めでも送る
        if (e && (e.count >= MAX_EVALUATION_REMINDERS || now - Date.parse(e.lastAt) < DAY - 30 * 60_000)) continue;
        const list = evalDue.get(u) ?? [];
        list.push({ iv, key });
        evalDue.set(u, list);
      }
    }
    for (const [u, items] of evalDue) {
      const ok = await sendMail(
        ctx,
        u.email,
        `評価の入力をお願いします(${items.length}件)`,
        `${u.name} さん\n\n次の面接の評価が、まだ提出されていません。録画を確認して、評価を入力・提出してください。\n\n${items
          .map((x) => itemLines(ctx, x.iv, "date"))
          .join("\n")}`,
      );
      if (!ok) continue;
      result.evaluation++;
      for (const { key } of items) log[key] = { count: (log[key]?.count ?? 0) + 1, lastAt: new Date(now).toISOString() };
      changed = true;
    }

    // ------------------------------------------------------------ 前日のお知らせ
    if (jstHour(now) >= settings.dayBeforeHour) {
      const tomorrow = jstDate(now + DAY);
      const dayDue = new Map<UserRecord, { iv: Interview; key: string }[]>();
      for (const iv of ivs) {
        if (iv.decision || !iv.scheduledAt || jstDate(Date.parse(iv.scheduledAt)) !== tomorrow) continue;
        for (const u of mailRecipients(ctx, iv, "dayBefore", (x) => iv.interviewerIds.includes(x.id))) {
          // 日時が変わったら、もう一度知らせる
          const key = `daybefore:${iv.id}:${u.id}:${iv.scheduledAt}`;
          if (log[key]) continue;
          const list = dayDue.get(u) ?? [];
          list.push({ iv, key });
          dayDue.set(u, list);
        }
      }
      for (const [u, items] of dayDue) {
        const [, m, d] = tomorrow.split("-").map(Number);
        const ok = await sendMail(
          ctx,
          u.email,
          `明日(${m}/${d})の面接のお知らせ(${items.length}件)`,
          `${u.name} さん\n\n明日、次の面接を担当します。\n\n${items.map((x) => itemLines(ctx, x.iv, "time")).join("\n")}\n\n当日は、録画の前に同意の確認をお願いします。`,
        );
        if (!ok) continue;
        result.dayBefore++;
        for (const { key } of items) log[key] = { count: 1, lastAt: new Date(now).toISOString() };
        changed = true;
      }
    }

    if (changed) await saveLog(ctx, log, now);
    return result;
  } finally {
    running.delete(ctx);
  }
}
