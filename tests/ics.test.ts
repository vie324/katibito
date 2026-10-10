// .ics(予定のファイル)の作成: 時刻の形式・特殊文字の扱い・長い行の折り返し。

import { describe, expect, it } from "vitest";
import { buildIcs } from "../src/app/ics";

describe("buildIcs", () => {
  const ev = {
    uid: "abc123@katibito",
    start: "2026-10-12T01:00:00.000Z",
    minutes: 13,
    summary: "面接: 山田 太郎(二次面接)",
    location: "本校 2F; 第1教室, 奥",
    description: "みらい子ども塾 の面接\n面接官: 一郎・二葉",
    url: "https://example.jp/interviews/abc123",
  };

  it("UTC の時刻で開始・終了を書き、改行・カンマ・セミコロンを逃がす", () => {
    const ics = buildIcs([ev], "面接の予定");
    const lines = ics.replace(/\r\n /g, "").split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("DTSTART:20261012T010000Z");
    expect(lines).toContain("DTEND:20261012T011300Z");
    expect(lines).toContain("UID:abc123@katibito");
    expect(lines).toContain("LOCATION:本校 2F\\; 第1教室\\, 奥");
    expect(lines).toContain("DESCRIPTION:みらい子ども塾 の面接\\n面接官: 一郎・二葉");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("1行 75 オクテットを超える行は、文字の途中で切らずに折り返す", () => {
    const long = { ...ev, description: "あ".repeat(80) };
    const ics = buildIcs([long], "予定");
    const raw = ics.split("\r\n");
    for (const l of raw) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    const desc = ics.replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith("DESCRIPTION:"));
    expect(desc).toBe(`DESCRIPTION:${"あ".repeat(80)}`);
  });
});
