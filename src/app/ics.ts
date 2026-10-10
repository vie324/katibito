// iCalendar(.ics)の作成。面接の予定を、各自のカレンダーアプリに取り込めるようにする。
// UID は面接ごとに固定なので、同じ面接を取り込み直すと(多くのアプリで)予定が更新される。

export type IcsEvent = {
  uid: string;
  /** 開始(ISO 8601) */
  start: string;
  minutes: number;
  summary: string;
  location: string;
  description: string;
  url: string;
};

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");
}

/** 20261012T010000Z の形(UTC) */
function stamp(t: string | Date): string {
  const d = typeof t === "string" ? new Date(t) : t;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 1行 75 オクテットごとに折り返す(UTF-8 の文字の途中では切らない) */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    // 2行目以降は先頭の空白1つも数える
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + b > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(events: IcsEvent[], calendarName: string): string {
  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//katibito//interview//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
  ];
  for (const e of events) {
    const end = new Date(Date.parse(e.start) + e.minutes * 60_000);
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${now}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** 面接1件分の予定(一覧の項目から) */
export function interviewEvent(
  it: { id: string; scheduledAt: string | null; plannedMinutes: number | null; round: string; location: string; candidate: { displayName: string } },
  opts: { orgName: string; interviewerNames: string[] },
): IcsEvent | null {
  if (!it.scheduledAt) return null;
  const url = `${window.location.origin}/interviews/${it.id}`;
  return {
    uid: `${it.id}@katibito`,
    start: it.scheduledAt,
    minutes: Math.max(15, it.plannedMinutes ?? 30),
    summary: `面接: ${it.candidate.displayName}${it.round ? `(${it.round})` : ""}`,
    location: it.location,
    description: [opts.orgName && `${opts.orgName} の面接`, opts.interviewerNames.length > 0 && `面接官: ${opts.interviewerNames.join("・")}`, url]
      .filter(Boolean)
      .join("\n"),
    url,
  };
}
