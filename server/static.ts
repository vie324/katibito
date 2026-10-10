// ビルド済みクライアント(dist/)の配信。SPA なので未知のパスは index.html を返す。

import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { sendFileRange } from "./media";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".map": "application/json",
};

/**
 * 画面の CSP。MediaPipe(WASM)のため wasm-unsafe-eval を許可する。
 * 外部への通信・読み込みは一切しない(connect-src 'self')。
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export function createStaticHandler(root: string) {
  const base = path.resolve(root);
  const index = path.join(base, "index.html");

  return async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end();
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (rel.includes("\0")) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const file = path.resolve(base, "." + rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    let target = file;
    let isFile = false;
    try {
      isFile = (await stat(file)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      // 拡張子つきのパス(存在しないアセット)は 404、それ以外は SPA のルート
      if (path.extname(rel) !== "") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("not found");
        return;
      }
      target = index;
    }

    const ext = path.extname(target).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    let cache = "no-cache";
    if (rel.startsWith("/assets/")) cache = "public, max-age=31536000, immutable";
    else if (rel.startsWith("/wasm/") || rel.startsWith("/models/")) cache = "public, max-age=86400";
    if (ext === ".html") res.setHeader("Content-Security-Policy", PAGE_CSP);
    await sendFileRange(req, res, target, type, cache);
  };
}
