// 合否通知書(印刷して渡す・郵送する文書)の文面。管理者が「設定 > 通知書」で変更できる。

import type { Interview, NoticeTemplate, Settings, Vote } from "./types";

export const DEFAULT_NOTICES: Record<Vote, NoticeTemplate> = {
  pass: {
    title: "選考結果のお知らせ",
    body: `{宛名}

このたびは、{団体名}の面接にお越しいただき、ありがとうございました。
慎重に選考いたしました結果、合格と決定いたしましたので、お知らせいたします。

今後の手続きにつきましては、あらためてご連絡いたします。
ご不明な点がございましたら、下記までお問い合わせください。

お問い合わせ先: {連絡先}`,
  },
  fail: {
    title: "選考結果のお知らせ",
    body: `{宛名}

このたびは、{団体名}の面接にお越しいただき、ありがとうございました。
慎重に選考いたしました結果、誠に残念ながら、今回はご期待に沿えない結果となりました。
ご理解くださいますよう、お願い申し上げます。

面接でのお話をうかがい、多くのことに真剣に取り組まれていることがよく伝わりました。
今後のご活躍を心よりお祈り申し上げます。

お問い合わせ先: {連絡先}`,
  },
  hold: {
    title: "選考についてのお知らせ",
    body: `{宛名}

このたびは、{団体名}の面接にお越しいただき、ありがとうございました。
選考の結果につきましては、もうしばらくお時間をいただき、あらためてご連絡いたします。
お待たせして申し訳ありませんが、よろしくお願い申し上げます。

お問い合わせ先: {連絡先}`,
  },
};

/** 差し込みに使える語(画面の説明用) */
export const NOTICE_PLACEHOLDERS = ["{宛名}", "{候補者名}", "{保護者名}", "{団体名}", "{面接日}", "{連絡先}"];

function jpDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });
}

/** 文面に差し込む。{宛名} は、保護者の同意があれば「保護者名 様」と「候補者名 様」の2行 */
export function renderNotice(tpl: NoticeTemplate, iv: Interview, settings: Pick<Settings, "orgName" | "contact">): NoticeTemplate {
  const candidate = iv.consent?.candidateName || iv.candidate.displayName;
  const guardian = iv.consent?.guardianName ?? "";
  const address = guardian ? `${guardian} 様\n${candidate} 様` : `${candidate} 様`;
  const map: Record<string, string> = {
    "{宛名}": address,
    "{候補者名}": candidate,
    "{保護者名}": guardian,
    "{団体名}": settings.orgName || "当団体",
    "{面接日}": jpDate(iv.scheduledAt ?? iv.createdAt),
    "{連絡先}": settings.contact || "",
  };
  const fill = (s: string) => s.replace(/\{(宛名|候補者名|保護者名|団体名|面接日|連絡先)\}/g, (m) => map[m] ?? m);
  return { title: fill(tpl.title), body: fill(tpl.body) };
}
