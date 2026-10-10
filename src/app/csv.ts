// 表計算ソフトの一覧(CSV・タブ区切り)の読み取り。Excel の CSV は Shift_JIS のことが多いので、文字コードも判定する。

/** UTF-8(BOM つき・なし)として読めなければ Shift_JIS として読む */
export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** CSV(RFC 4180)またはタブ区切り。引用符の中の区切り・改行・"" に対応 */
export function parseTable(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 表の1セル(数式として解釈されないよう、先頭が = + - @ なら ' をつける) */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * 日本時間の日時「2026/10/12 10:00」「2026-10-12 10:00:00」「2026年10月12日 10時00分」を ISO 8601 に。
 * 読めなければ null
 */
export function parseJstDateTime(s: string): string | null {
  const m = s
    .trim()
    .replace(/[年月]/g, "/")
    .replace(/日/g, " ")
    .replace(/時/g, ":")
    .replace(/分/g, "")
    .match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+09:00`);
  if (Number.isNaN(iso.getTime())) return null;
  // 2/30 のような存在しない日付を弾く
  const back = new Date(iso.getTime() + 9 * 3600_000);
  if (back.getUTCDate() !== d || back.getUTCMonth() + 1 !== mo) return null;
  return iso.toISOString();
}
