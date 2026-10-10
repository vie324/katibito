// HTTP サーバーの組み立て。テストからも createApp() で起動する。

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ValidationError } from "../src/shared/validate";
import { Audit } from "./audit";
import { generateSetupCode, LoginLimiter, SESSION_COOKIE, Sessions } from "./auth";
import type { Config } from "./config";
import { Jobs, type AppContext } from "./context";
import { HANDLED, HttpError, parseCookies, Router, sendError, sendJson, type Ctx } from "./http";
import { resumeProcessing } from "./recordings";
import { mailEnabled } from "./mail";
import { runReminders } from "./reminders";
import { runRetention } from "./retention";
import { ffmpegPath, resumeTranscodes } from "./transcode";
import { resumeTranscriptions, whisperCli } from "./transcribe";
import { registerAccountRoutes } from "./routes/account";
import { registerAdminRoutes } from "./routes/admin";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerConsentLinkRoutes } from "./routes/consentLinks";
import { registerExportRoutes } from "./routes/export";
import { registerSearchRoutes } from "./routes/search";
import { registerInsightRoutes } from "./routes/insights";
import { canView, mustSetupTotp } from "./access";
import { registerInterviewRoutes } from "./routes/interviews";
import { registerRecordingRoutes } from "./routes/recordings";
import { createStaticHandler } from "./static";
import { Store } from "./store";

export type App = {
  ctx: AppContext;
  server: http.Server;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
};

/** 2段階認証を設定するまでの間も使える API */
const TOTP_SETUP_PATHS = /^\/api\/(session|logout|health|me|me\/totp(\/[a-z]+)?|me\/password)$/;

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=()");
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v?.split(",")[0]?.trim() || undefined;
}

/** 末尾の値。X-Forwarded-For は経由したプロキシが末尾に追記していくため、信頼できるのは末尾(直前のプロキシが見た接続元) */
function lastHeader(v: string | string[] | undefined): string | undefined {
  const all = (Array.isArray(v) ? v.join(",") : (v ?? "")).split(",").map((x) => x.trim()).filter(Boolean);
  return all.at(-1);
}

/** 接続の情報(リバースプロキシの後ろでは X-Forwarded-* を使う) */
export function requestMeta(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy: boolean,
): { secure: boolean; origin: string; ip: string } {
  const secure = trustProxy
    ? firstHeader(req.headers["x-forwarded-proto"]) === "https"
    : Boolean((req.socket as { encrypted?: boolean }).encrypted);
  const host = (trustProxy ? firstHeader(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host ?? "localhost";
  const ip = (trustProxy ? lastHeader(req.headers["x-forwarded-for"]) : undefined) ?? req.socket.remoteAddress ?? "unknown";
  return { secure, origin: `${secure ? "https" : "http"}://${host}`, ip };
}

export async function createApp(config: Config, opts: { log?: boolean } = {}): Promise<App> {
  const store = await Store.open(config.dataDir);
  const ctx: AppContext = {
    config,
    store,
    sessions: new Sessions(store, config.sessionTtlMs),
    limiter: new LoginLimiter(),
    audit: new Audit(path.join(store.dir, "audit")),
    jobs: new Jobs(),
    setup: { code: null },
    lastOrigin: null,
    live: new Map(),
    loginTickets: new Map(),
  };
  const log = opts.log ?? true;

  if (log) {
    console.log(ffmpegPath() ? "[server] ffmpeg あり: 再生用の MP4 を作成します(iPhone 等で再生可能)" : "[server] ffmpeg なし: 録画は WebM のまま配信します");
    console.log(
      whisperCli(ctx) && ffmpegPath()
        ? `[server] whisper.cpp あり: 録画の音声を文字起こしします(モデル ${config.transcription.model}、サーバー内で処理)`
        : "[server] whisper.cpp なし: 文字起こしは使えません",
    );
    console.log(
      mailEnabled(ctx)
        ? `[server] メール: ${config.mail.host}:${config.mail.port} から送信します(差出人 ${config.mail.from})`
        : "[server] メール: SMTP_HOST・MAIL_FROM が未設定のため送信しません",
    );
  }

  if (store.users.size === 0) {
    ctx.setup.code = config.setupCode ?? generateSetupCode();
    if (log) {
      const line = "=".repeat(56);
      console.log(`\n${line}\n 初期設定コード: ${ctx.setup.code}\n ブラウザでこのアプリを開き、初期設定画面で入力してください。\n${line}\n`);
    }
  }

  const router = new Router();
  registerAccountRoutes(router, ctx);
  registerInterviewRoutes(router, ctx);
  registerRecordingRoutes(router, ctx);
  registerAdminRoutes(router, ctx);
  registerInsightRoutes(router, ctx);
  registerAttachmentRoutes(router, ctx);
  registerConsentLinkRoutes(router, ctx);
  registerSearchRoutes(router, ctx);
  registerExportRoutes(router, ctx);

  const serveStatic = config.staticDir ? createStaticHandler(config.staticDir) : null;

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, c: Ctx): Promise<void> {
    const m = router.match(req.method ?? "GET", url.pathname);
    if (m === null) throw new HttpError(404, "見つかりません");
    if (m === "method-not-allowed") throw new HttpError(405, "このメソッドは使えません");
    c.params = m.params;

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE] ?? null;
    const userId = ctx.sessions.resolve(token ?? undefined);
    const user = userId ? store.users.get(userId) ?? null : null;
    c.user = user && !user.disabled ? user : null;
    c.sessionToken = token;

    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // CSRF 対策: 独自ヘッダ(クロスサイトからは CORS の事前確認なしに付けられない)+ Origin の照合
      if (req.headers["x-requested-with"] !== "katibito") throw new HttpError(403, "不正なリクエストです");
      const origin = req.headers.origin;
      if (origin && origin !== c.origin) throw new HttpError(403, "不正なリクエスト元です");
      // 通知のリンク先(APP_URL 未設定時)。ログイン済みの利用者のブラウザが送った Origin だけを使う
      // (Host ヘッダを書き換えたリクエストで、リンク先を別のサイトに向けられないように)
      if (!ctx.config.appUrl && c.user && origin === c.origin) ctx.lastOrigin = origin;
    }

    if (m.route.auth !== "none" && !c.user) throw new HttpError(401, "ログインしてください");
    // 管理者に2段階認証が必須なのに未設定なら、設定するまでほかの操作はさせない
    if (c.user && mustSetupTotp(ctx, c.user) && !TOTP_SETUP_PATHS.test(url.pathname)) {
      throw new HttpError(403, "管理者は2段階認証の設定が必要です。「アカウント」で設定してください");
    }
    if (m.route.auth === "admin" && c.user?.role !== "admin") throw new HttpError(403, "管理者のみ実行できます");
    // 面接ごとの API は、その面接を見られる人だけ(見られない面接は「見つからない」と同じ応答にする)
    if (c.user && c.params.id && url.pathname.startsWith("/api/interviews/")) {
      const iv = store.interviews.get(c.params.id);
      if (iv && !canView(ctx, c.user, iv)) throw new HttpError(404, "面接が見つかりません");
    }

    const result = await m.route.handler(c);
    if (result === HANDLED || res.writableEnded) return;
    sendJson(res, 200, result ?? { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const { secure, origin, ip } = requestMeta(req, config.trustProxy);

    if (url.pathname.startsWith("/api/")) {
      const c: Ctx = {
        req,
        res,
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        params: {},
        ip,
        secure,
        origin,
        user: null,
        sessionToken: null,
      };
      try {
        await handleApi(req, res, url, c);
      } catch (e) {
        if (!(e instanceof HttpError) && !(e instanceof ValidationError)) {
          console.error(`[api] ${req.method} ${url.pathname}`, e);
        }
        sendError(res, e);
      }
      return;
    }

    if (serveStatic) {
      try {
        await serveStatic(req, res, url.pathname);
      } catch (e) {
        console.error("[static]", e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("クライアントがビルドされていません(npm run build)");
  });
  // 大きなチャンクのアップロードが遅い回線でも切れないように
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await resumeProcessing(ctx);
  resumeTranscodes(ctx);
  await resumeTranscriptions(ctx);

  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let retentionStartup: ReturnType<typeof setTimeout> | null = null;
  let reminderTimer: ReturnType<typeof setInterval> | null = null;

  return {
    ctx,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          // 保存期間の処理: 起動1分後と、以後定期的に
          retentionStartup = setTimeout(() => void runRetention(ctx).catch((e) => console.error("[retention]", e)), 60_000);
          retentionTimer = setInterval(
            () => void runRetention(ctx).catch((e) => console.error("[retention]", e)),
            config.retentionIntervalMs,
          );
          retentionStartup.unref?.();
          retentionTimer.unref?.();
          // メールのお知らせ(評価の催促・前日のお知らせ)
          reminderTimer = setInterval(
            () => void runReminders(ctx).catch((e) => console.error("[reminders]", e)),
            config.reminderIntervalMs,
          );
          reminderTimer.unref?.();
          resolve(server.address() as AddressInfo);
        });
      });
    },
    async close() {
      if (retentionTimer) clearInterval(retentionTimer);
      if (reminderTimer) clearInterval(reminderTimer);
      if (retentionStartup) clearTimeout(retentionStartup);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await ctx.jobs.idle();
      await store.saveSessions();
    },
  };
}
