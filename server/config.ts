// 環境変数からの設定読み込み。

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  /** ビルド済みクライアント(dist/)。null ならAPIのみ */
  staticDir: string | null;
  /** リバースプロキシ(Caddy 等)の X-Forwarded-* を信用する */
  trustProxy: boolean;
  /** Cookie の Secure 属性。auto は https で受けたときだけ付ける */
  cookieSecure: "auto" | boolean;
  /** 通知に載せるURL(例 https://interview.example.jp)。未設定ならリクエストから推定 */
  appUrl: string | null;
  /** 初期設定コードを固定したい場合(未設定なら起動時に生成してログに出す) */
  setupCode: string | null;
  maxChunkBytes: number;
  maxTrackBytes: number;
  sessionTtlMs: number;
  /** 保存期間の削除処理の実行間隔 */
  retentionIntervalMs: number;
};

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === "") return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function defaultStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist-server/main.js からは ../dist、server/*.ts からも ../dist
  const candidate = path.resolve(here, "..", "dist");
  return existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cookie = env.COOKIE_SECURE;
  return {
    port: int(env.PORT, 8787),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || "data"),
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : defaultStaticDir(),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: cookie === undefined || cookie === "" || cookie === "auto" ? "auto" : bool(cookie, false),
    appUrl: env.APP_URL ? env.APP_URL.replace(/\/+$/, "") : null,
    setupCode: env.INITIAL_SETUP_CODE || null,
    maxChunkBytes: int(env.MAX_CHUNK_MB, 32) * 1024 * 1024,
    maxTrackBytes: 64 * 1024 * 1024,
    sessionTtlMs: int(env.SESSION_DAYS, 14) * 24 * 3600_000,
    retentionIntervalMs: 6 * 3600_000,
  };
}
