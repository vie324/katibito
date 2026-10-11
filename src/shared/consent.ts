// 同意文の差し込み。画面表示(クライアント)と記録(サーバー)で同じ結果になること。

import type { ConsentRecord, Settings } from "./types";

/** 同意の取り方(記録票・書き出し・詳細画面) */
export const CONSENT_METHOD_LABEL: Record<ConsentRecord["method"], string> = {
  onscreen: "画面で取得",
  paper: "紙の同意書",
  online: "オンラインで入力",
  verbal: "口頭で確認(オンライン面接)",
};

export function renderConsentText(settings: Pick<Settings, "orgName" | "contact" | "consent" | "retention">): {
  title: string;
  body: string;
} {
  const fill = (s: string) =>
    s
      .replaceAll("{団体名}", settings.orgName.trim() || "当団体")
      .replaceAll("{保存日数}", String(settings.retention.videoDaysAfterDecision))
      .replaceAll("{連絡先}", settings.contact.trim() || "面接担当者");
  return { title: fill(settings.consent.title), body: fill(settings.consent.body) };
}

/** 記録用に1つの文字列にまとめる */
export function consentSnapshot(rendered: { title: string; body: string }): string {
  return `${rendered.title}\n\n${rendered.body}`;
}
