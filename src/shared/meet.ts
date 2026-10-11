// Google Meet のリンクの検証と正規化(画面・サーバーで共通)。
// 面接の記録・メール・予定(.ics)に載せるので、meet.google.com のリンクだけを受け付ける
// (ほかのサイトへのリンクを、Meet のリンクとして職員に案内しないように)。

/** 会議コード(abc-defg-hij)の形 */
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const MEET_NEW_URL = "https://meet.new";

/**
 * Google Meet のリンクを正規化する。Meet のリンクでなければ null。
 * - 「meet.google.com/abc-defg-hij」のように https:// がなくてもよい。会議コードだけ(abc-defg-hij)でもよい
 * - クエリ(?authuser=1 など、開いた人の Google アカウントの番号)と # 以降は除く
 */
export function normalizeMeetUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  if (CODE.test(s.toLowerCase())) return `https://meet.google.com/${s.toLowerCase()}`;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.hostname.toLowerCase() !== "meet.google.com" || u.port || u.username || u.password) return null;
  // アプリ版の Meet のリンク(/_meet/abc-defg-hij)も同じ会議
  const path = u.pathname.replace(/\/+$/, "").replace(/^\/_meet(?=\/)/, "");
  const code = path.slice(1).toLowerCase();
  if (CODE.test(code)) return `https://meet.google.com/${code}`;
  // 名前で作った会議(meet.google.com/lookup/…)
  const m = /^\/lookup\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (m) return `https://meet.google.com/lookup/${m[1]}`;
  return null;
}

/** 場所の表示。オンライン面接で場所が空なら「オンライン(Google Meet)」 */
export function placeLabel(iv: { location: string; format: "inPerson" | "online" }): string {
  return iv.location || (iv.format === "online" ? "オンライン(Google Meet)" : "");
}

/** 画面に出す短い表記(meet.google.com/abc-defg-hij) */
export function meetLabel(url: string): string {
  return url.replace(/^https:\/\//, "");
}
