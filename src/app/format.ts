// 表示用の整形(日時は日本時間で表示する)。

import { formatClockMs } from "../shared/time";

const TZ = "Asia/Tokyo";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ja-JP", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
}

/** 時刻だけ(14:32) */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("ja-JP", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

/** 日本時間での日付(YYYY-MM-DD)。日付での絞り込み・予定表の日の区切りに使う */
export function jstDateKey(t: string | Date): string {
  const ms = typeof t === "string" ? Date.parse(t) : t.getTime();
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 経過時間 m:ss / h:mm:ss */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return formatClockMs(ms);
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 1) return `${Math.round(ms / 1000)}秒`;
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60}分`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/** <input type="datetime-local"> 用(日本時間) */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return jst.toISOString().slice(0, 16);
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
