// ファイル配信(Range 対応)とチャンクの結合。

import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

/**
 * 単一範囲の Range リクエストに対応したファイル送信。
 * <video> のシークはここを通る(Cues があれば、末尾の索引 → 目的の位置 と少量ずつ読まれる)。
 */
export async function sendFileRange(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  contentType: string,
  cacheControl = "private, no-cache",
): Promise<void> {
  const st = await stat(file);
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", st.mtime.toUTCString());

  if (req.headers["if-none-match"] === etag && !req.headers.range) {
    res.statusCode = 304;
    res.end();
    return;
  }

  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  const ifRange = req.headers["if-range"];
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    if (m[1] === "") {
      // 末尾から N バイト
      const n = Number(m[2]);
      start = Math.max(0, size - n);
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(size - 1, Number(m[2]));
    }
    if (start >= size || start > end) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else {
    res.statusCode = 200;
  }
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  res.on("close", () => stream.destroy());
  try {
    await pipeline(stream, res);
  } catch (e) {
    // 再生中のシークでクライアントが接続を切るのは正常
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ECONNRESET" && code !== "EPIPE") throw e;
  }
}

/** チャンクファイルを順に連結する(書き込み側の詰まりを待ちながら) */
export async function concatFiles(files: string[], out: string): Promise<number> {
  const ws = createWriteStream(out);
  let failed: Error | null = null;
  ws.on("error", (e) => (failed = e));
  let total = 0;
  try {
    for (const f of files) {
      for await (const chunk of createReadStream(f)) {
        if (failed) throw failed;
        total += (chunk as Buffer).length;
        if (!ws.write(chunk)) await once(ws, "drain");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
  if (failed) throw failed;
  return total;
}

export function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function extensionFor(mime: string): string {
  switch (baseMime(mime)) {
    case "video/webm":
    case "audio/webm":
      return "webm";
    case "video/x-matroska":
      return "mkv";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    default:
      return "bin";
  }
}

/** 配信時の Content-Type。iPhone の .mov(H.264)は mp4 として渡すと Chrome で再生できる */
export function servingType(mime: string): string {
  const b = baseMime(mime);
  if (b === "video/quicktime") return "video/mp4";
  if (b.startsWith("video/") || b.startsWith("audio/")) return b;
  return "application/octet-stream";
}

export function isWebm(mime: string): boolean {
  const b = baseMime(mime);
  return b === "video/webm" || b === "audio/webm" || b === "video/x-matroska";
}
