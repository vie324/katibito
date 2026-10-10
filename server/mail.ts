// メールの送信(SMTP)。SMTP_HOST と MAIL_FROM が未設定なら送らない。
// お知らせのメールは失敗しても本処理を止めない(sendMail は false を返すだけ)。

import { createTransport } from "nodemailer";
import type { AppContext } from "./context";
import type { UserRecord } from "./store";

type Transporter = ReturnType<typeof createTransport>;
const transports = new WeakMap<AppContext, Transporter>();

export function mailEnabled(ctx: AppContext): boolean {
  return !!ctx.config.mail.host && !!ctx.config.mail.from;
}

function transport(ctx: AppContext): Transporter {
  let t = transports.get(ctx);
  if (!t) {
    const m = ctx.config.mail;
    t = createTransport({
      host: m.host!,
      port: m.port,
      secure: m.secure,
      // 465 番以外は STARTTLS で暗号化する。暗号化できない相手には送らない(テスト用のサーバーを除く)
      requireTLS: !m.secure && m.requireTls,
      ignoreTLS: !m.secure && !m.requireTls,
      auth: m.user ? { user: m.user, pass: m.pass ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    transports.set(ctx, t);
  }
  return t;
}

/** 署名(全メール共通) */
function footer(ctx: AppContext): string {
  const org = ctx.store.settings.orgName.trim();
  return `\n\n--\nこのメールは${org ? ` ${org} の` : ""}面接記録アプリから自動で送信しています。\nお知らせの受け取り方は、アプリの「アカウント」で変更できます。`;
}

/** 送る(失敗したら例外)。テストメールなど、結果をそのまま画面に返すときに使う */
export async function sendMailOrThrow(ctx: AppContext, to: string, subject: string, text: string): Promise<void> {
  if (!mailEnabled(ctx)) throw new Error("サーバーでメール(SMTP)が設定されていません");
  await transport(ctx).sendMail({
    from: ctx.config.mail.from!,
    to,
    subject: `【面接記録】${subject}`,
    text: text + footer(ctx),
  });
}

/** 送る(失敗してもログに残すだけ) */
export async function sendMail(ctx: AppContext, to: string, subject: string, text: string): Promise<boolean> {
  if (!mailEnabled(ctx) || !to) return false;
  try {
    await sendMailOrThrow(ctx, to, subject, text);
    return true;
  } catch (e) {
    console.warn(`[mail] ${to} への送信に失敗しました`, (e as Error).message);
    return false;
  }
}

/** 何人かに同じ内容を送る(1通ずつ。宛先どうしにアドレスが見えないように) */
export async function sendMailToUsers(ctx: AppContext, users: UserRecord[], subject: string, text: string): Promise<number> {
  let sent = 0;
  for (const u of users) if (await sendMail(ctx, u.email, subject, text)) sent++;
  return sent;
}

export function mailStatus(ctx: AppContext): { enabled: boolean; host: string | null; from: string | null } {
  return { enabled: mailEnabled(ctx), host: ctx.config.mail.host, from: ctx.config.mail.from };
}
