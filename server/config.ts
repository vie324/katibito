// 環境変数からの設定読み込み。

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
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
  /** メール(SMTP)。host か from が未設定なら送らない */
  mail: {
    host: string | null;
    port: number;
    /** true: 最初から TLS(465 番) / false: STARTTLS(587 番など) */
    secure: boolean;
    /** STARTTLS を必須にする(暗号化できないサーバーには送らない)。テスト用の SMTP サーバー以外では true のまま */
    requireTls: boolean;
    user: string | null;
    pass: string | null;
    /** 差出人(例: 面接記録 <noreply@example.jp>) */
    from: string | null;
  };
  /** お知らせ(催促・前日)を確かめる間隔 */
  reminderIntervalMs: number;
  /** 文字起こし(whisper.cpp)。サーバー内で処理し、外部には送らない */
  transcription: {
    /** auto: whisper-cli が見つかれば使う / off: 使わない */
    mode: "auto" | "off";
    cli: string;
    /** モデル名(ggml-<名前>.bin)。small-q5_1 / base / medium-q5_0 / large-v3-turbo-q5_0 など */
    model: string;
    /** モデルの置き場所(なければ最初に使うときに取得する)。null なら DATA_DIR/models */
    modelsDir: string | null;
    modelBaseUrl: string;
    vadUrl: string;
    threads: number;
  };
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
    mail: {
      host: env.SMTP_HOST || null,
      port: int(env.SMTP_PORT, bool(env.SMTP_SECURE, false) ? 465 : 587),
      secure: bool(env.SMTP_SECURE, false) || env.SMTP_PORT === "465",
      requireTls: bool(env.SMTP_REQUIRE_TLS, true),
      user: env.SMTP_USER || null,
      pass: env.SMTP_PASS || null,
      from: env.MAIL_FROM || null,
    },
    reminderIntervalMs: 15 * 60_000,
    transcription: {
      mode: ["0", "false", "off", "no"].includes((env.TRANSCRIBE ?? "").toLowerCase()) ? "off" : "auto",
      cli: env.WHISPER_CLI || "whisper-cli",
      model: env.WHISPER_MODEL || "small-q5_1",
      modelsDir: env.WHISPER_MODELS_DIR ? path.resolve(env.WHISPER_MODELS_DIR) : null,
      modelBaseUrl: (env.WHISPER_MODEL_BASE_URL || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main").replace(/\/+$/, ""),
      vadUrl: env.WHISPER_VAD_URL || "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
      threads: Math.max(1, int(env.WHISPER_THREADS, Math.max(1, availableParallelism() - 1))),
    },
  };
}
