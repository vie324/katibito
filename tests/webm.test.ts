// WebM 索引付け(server/webm.ts)。Chromium の MediaRecorder の実出力で検証する。

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { indexWebm, inspectWebm, WebmFormatError } from "../server/webm";

const FIXTURES = path.join(__dirname, "fixtures");
const dir = mkdtempSync(path.join(tmpdir(), "webm-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function hasFfprobe(): boolean {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffprobeDuration(file: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

describe("indexWebm", () => {
  it.each(["chrome-recording.webm", "chrome-recording-alpha.webm"])(
    "%s: Duration と Cues を付与し、Segment サイズを確定させる",
    async (name) => {
      const src = path.join(FIXTURES, name);
      const before = await inspectWebm(src);
      expect(before.durationMs).toBeNull();
      expect(before.cueCount).toBe(0);
      expect(before.segmentSizeKnown).toBe(false);

      const out = path.join(dir, `indexed-${name}`);
      const res = await indexWebm(src, out);
      expect(res.truncated).toBe(false);
      expect(res.clusterCount).toBeGreaterThan(1);
      expect(res.cueCount).toBeGreaterThan(0);
      expect(res.durationMs).toBeGreaterThan(2000);

      const after = await inspectWebm(out);
      expect(after.segmentSizeKnown).toBe(true);
      expect(after.cueCount).toBe(res.cueCount);
      expect(after.durationMs).toBe(res.durationMs);

      // Cues が指す位置に Cluster の ID があること
      const buf = readFileSync(out);
      const segStart = buf.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67])) + 12;
      const cuesAt = buf.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
      expect(cuesAt).toBeGreaterThan(segStart);
      let p = cuesAt;
      let checked = 0;
      while ((p = buf.indexOf(Buffer.from([0xf1, 0x88]), p + 1)) > 0) {
        let pos = 0;
        for (let i = 0; i < 8; i++) pos = pos * 256 + buf[p + 2 + i];
        expect(buf.subarray(segStart + pos, segStart + pos + 4)).toEqual(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
        checked++;
      }
      expect(checked).toBe(res.cueCount);

      if (hasFfprobe()) {
        const d = ffprobeDuration(out);
        expect(Math.abs(d * 1000 - res.durationMs)).toBeLessThan(150);
      }
    },
  );

  it("チャンクを連結した入力でも同じ結果になる(MediaRecorder の timeslice 分割)", async () => {
    const src = readFileSync(path.join(FIXTURES, "chrome-recording.webm"));
    // 任意の位置で分割して連結し直す(サーバーのチャンク結合と同じ)
    const parts = [src.subarray(0, 1000), src.subarray(1000, 30_000), src.subarray(30_000)];
    const joined = path.join(dir, "joined.webm");
    writeFileSync(joined, Buffer.concat(parts));
    const a = await indexWebm(path.join(FIXTURES, "chrome-recording.webm"), path.join(dir, "a.webm"));
    const b = await indexWebm(joined, path.join(dir, "b.webm"));
    expect(b).toEqual(a);
  });

  it("途中で途切れたファイルは最後の完全な要素までで切り詰める", async () => {
    const src = readFileSync(path.join(FIXTURES, "chrome-recording.webm"));
    const cut = path.join(dir, "cut.webm");
    writeFileSync(cut, src.subarray(0, Math.floor(src.length * 0.7)));
    const out = path.join(dir, "cut-indexed.webm");
    const res = await indexWebm(cut, out);
    expect(res.truncated).toBe(true);
    expect(res.durationMs).toBeGreaterThan(1000);
    const full = await indexWebm(path.join(FIXTURES, "chrome-recording.webm"), path.join(dir, "full.webm"));
    expect(res.durationMs).toBeLessThan(full.durationMs);
    if (hasFfprobe()) {
      expect(ffprobeDuration(out)).toBeGreaterThan(1);
    }
  });

  it("索引付け済みのファイルをもう一度通しても壊れない", async () => {
    const once = path.join(dir, "once.webm");
    const twice = path.join(dir, "twice.webm");
    const r1 = await indexWebm(path.join(FIXTURES, "chrome-recording-alpha.webm"), once);
    const r2 = await indexWebm(once, twice);
    expect(r2.durationMs).toBe(r1.durationMs);
    expect(r2.cueCount).toBe(r1.cueCount);
    expect(readFileSync(twice).length).toBe(readFileSync(once).length);
  });

  it("WebM でないファイルはエラー", async () => {
    const bogus = path.join(dir, "bogus.webm");
    writeFileSync(bogus, Buffer.from("this is not a webm file at all"));
    await expect(indexWebm(bogus, path.join(dir, "x.webm"))).rejects.toBeInstanceOf(WebmFormatError);
    const mp4ish = path.join(dir, "mp4ish.webm");
    copyFileSync(path.join(FIXTURES, "chrome-recording.webm"), mp4ish);
    const head = readFileSync(mp4ish);
    head[0] = 0x00;
    writeFileSync(mp4ish, head);
    await expect(indexWebm(mp4ish, path.join(dir, "y.webm"))).rejects.toBeInstanceOf(WebmFormatError);
  });

  it("ファイルが申告する巨大な要素サイズをそのままメモリに読まない", async () => {
    // EBML ヘッダ + Segment(サイズ不明)+ 8MB と申告する Info(上限 4MB を超える)
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const segment = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const info = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x01, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00]);
    const huge = path.join(dir, "huge-info.webm");
    writeFileSync(huge, Buffer.concat([ebml, segment, info, Buffer.alloc(8 * 1024 * 1024)]));
    await expect(indexWebm(huge, path.join(dir, "z.webm"))).rejects.toThrow(/大きすぎ/);
  });
});
