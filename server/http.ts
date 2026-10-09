// 小さなルーターと HTTP ヘルパー(フレームワークなし)。

import type { IncomingMessage, ServerResponse } from "node:http";
import { ValidationError } from "../src/shared/validate";
import type { UserRecord } from "./store";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const HANDLED = Symbol("handled");

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  ip: string;
  /** https で受けているか(TRUST_PROXY 時は X-Forwarded-Proto を見る) */
  secure: boolean;
  /** 外から見たこのアプリの URL(通知のリンクに使う) */
  origin: string;
  user: UserRecord | null;
  sessionToken: string | null;
};

export type Auth = "none" | "user" | "admin";
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

type Route = {
  method: string;
  parts: string[];
  auth: Auth;
  handler: Handler;
};

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, auth: Auth, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), auth, handler });
  }

  get(p: string, auth: Auth, h: Handler) {
    this.add("GET", p, auth, h);
  }
  post(p: string, auth: Auth, h: Handler) {
    this.add("POST", p, auth, h);
  }
  put(p: string, auth: Auth, h: Handler) {
    this.add("PUT", p, auth, h);
  }
  patch(p: string, auth: Auth, h: Handler) {
    this.add("PATCH", p, auth, h);
  }
  delete(p: string, auth: Auth, h: Handler) {
    this.add("DELETE", p, auth, h);
  }

  match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | "method-not-allowed" | null {
    const parts = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(":")) {
          try {
            params[rp.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (rp !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      const m = method === "HEAD" ? "GET" : method;
      if (r.method === m) return { route: r, params };
    }
    return pathMatched ? "method-not-allowed" : null;
  }
}

/** リクエストボディを上限つきで読む */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? -1);
    if (declared > limit) {
      reject(new HttpError(413, "データが大きすぎます"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > limit) {
        done = true;
        reject(new HttpError(413, "データが大きすぎます"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
    req.on("aborted", () => {
      if (done) return;
      done = true;
      reject(new HttpError(400, "通信が中断されました"));
    });
  });
}

export async function readJson(ctx: Ctx, limit = 1 << 20): Promise<unknown> {
  const ct = String(ctx.req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type は application/json にしてください");
  }
  const body = await readBody(ctx.req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON を読めません");
  }
}

export async function readBinary(ctx: Ctx, limit: number): Promise<Buffer> {
  const ct = String(ctx.req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.startsWith("application/octet-stream") && !ct.startsWith("application/gzip")) {
    throw new HttpError(415, "Content-Type は application/octet-stream にしてください");
  }
  return readBody(ctx.req, limit);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", data.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
}

export function sendError(res: ServerResponse, e: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (e instanceof HttpError) {
    sendJson(res, e.status, { error: e.message });
  } else if (e instanceof ValidationError) {
    sendJson(res, 400, { error: e.message });
  } else {
    sendJson(res, 500, { error: "サーバーでエラーが発生しました" });
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: { maxAgeSec: number; secure: boolean },
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
  ];
  if (opts.secure) parts.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader("Set-Cookie", [...list, parts.join("; ")]);
}

/** Content-Disposition(日本語ファイル名対応) */
export function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
