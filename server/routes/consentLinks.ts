// 事前のオンライン同意。面接の担当者が本人・保護者に送るリンクを作り、受け取った人はログインせずに同意を入力する。
// リンクのトークンは作成時に1度だけ返し、サーバーには SHA-256 だけを保存する。

import { createHash, randomBytes } from "node:crypto";
import { consentSnapshot, renderConsentText } from "../../src/shared/consent";
import type { ConsentLink, ConsentRecord, Interview, PublicConsentInfo } from "../../src/shared/types";
import { bool, id, int, obj, str, ValidationError } from "../../src/shared/validate";
import type { AppContext } from "../context";
import { HttpError, readJson, type Ctx, type Router } from "../http";
import { notifyConsentOnline } from "../notifications";
import { newId } from "../store";
import { audit, buildDetail, getInterview, isMinor } from "./interviews";

const MAX_LINKS = 20;
const DAY = 24 * 3600_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** トークンからリンクを探す(トークンの形が違えば探さない) */
function findByToken(app: AppContext, token: string): { iv: Interview; link: ConsentLink } | null {
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
  const h = hashToken(token);
  for (const iv of app.store.interviews.values()) {
    const link = iv.consentLinks.find((l) => l.tokenHash === h);
    if (link) return { iv, link };
  }
  return null;
}

export function linkState(iv: Interview, link: ConsentLink, now = Date.now()): PublicConsentInfo["state"] {
  if (iv.consent || link.usedAt) return "done";
  if (link.revokedAt) return "revoked";
  // 判定済みの面接には、もう同意を入力できない
  if (Date.parse(link.expiresAt) <= now || iv.decision) return "expired";
  return "open";
}

function renderedConsent(app: AppContext) {
  const rendered = renderConsentText(app.store.settings);
  const text = consentSnapshot(rendered);
  return { rendered, text, version: versionOf(text) };
}

/**
 * 公開の(ログイン不要の)入口。間違ったトークンを続けて送る接続元は一時的に止める。
 * 接続元ごとのキーにして、ほかの人の失敗で正しいリンクの人まで止まらないようにする
 */
function lookup(app: AppContext, c: Ctx): { iv: Interview; link: ConsentLink } {
  const key = `consent-link:${c.ip}`;
  if (app.limiter.blocked(c.ip, key)) {
    throw new HttpError(429, "試行回数が多すぎます。しばらく待ってから再度お試しください");
  }
  const found = findByToken(app, c.params.token);
  if (!found) {
    app.limiter.fail(c.ip, key);
    throw new HttpError(404, "リンクが見つかりません。URL が正しいか確かめるか、送ってくれた担当者にお問い合わせください");
  }
  return found;
}

const STATE_MESSAGE: Record<Exclude<PublicConsentInfo["state"], "open">, string> = {
  done: "同意の記録はすでに済んでいます",
  expired: "このリンクの有効期限が切れています。送ってくれた担当者にお問い合わせください",
  revoked: "このリンクは使えなくなっています。送ってくれた担当者にお問い合わせください",
};

export function registerConsentLinkRoutes(r: Router, app: AppContext): void {
  const { store } = app;

  // ---------------------------------------------------------------- 担当者: リンクを作る・取り消す
  r.post("/api/interviews/:id/consent-links", "user", async (c) => {
    const body = obj(await readJson(c));
    const days = int(body.days, "有効期限", { min: 1, max: 60, optional: true }) ?? 14;
    const token = randomBytes(32).toString("base64url");
    const out = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      if (iv.decision) throw new HttpError(409, "判定済みの面接です");
      if (iv.consent) throw new HttpError(409, "同意はすでに記録されています");
      if (iv.consentLinks.length >= MAX_LINKS) throw new HttpError(409, `同意のリンクは1つの面接につき ${MAX_LINKS} 件までです`);
      const now = Date.now();
      const link: ConsentLink = {
        id: newId(),
        tokenHash: hashToken(token),
        createdBy: c.user!.id,
        createdByName: c.user!.name,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + days * DAY).toISOString(),
        usedAt: null,
        revokedAt: null,
      };
      iv.consentLinks.push(link);
      await store.saveInterview(iv);
      return { link, detail: buildDetail(app, iv, c.user!) };
    });
    await audit(app, c, "consent_link_create", c.params.id, `days=${days}`);
    return { token, link: { ...out.link, tokenHash: "" }, detail: out.detail };
  });

  r.delete("/api/interviews/:id/consent-links/:lid", "user", async (c) => {
    const lid = id(c.params.lid, "リンク");
    const detail = await store.withLock(c.params.id, async () => {
      const iv = getInterview(app, c.params.id);
      const link = iv.consentLinks.find((l) => l.id === lid);
      if (!link) throw new HttpError(404, "リンクが見つかりません");
      if (!link.revokedAt && !link.usedAt) {
        link.revokedAt = new Date().toISOString();
        await store.saveInterview(iv);
      }
      return buildDetail(app, iv, c.user!);
    });
    await audit(app, c, "consent_link_revoke", c.params.id);
    return detail;
  });

  // ---------------------------------------------------------------- 本人・保護者(ログイン不要)
  r.get("/api/public/consent/:token", "none", (c): PublicConsentInfo => {
    const { iv, link } = lookup(app, c);
    const s = store.settings;
    const { rendered, version } = renderedConsent(app);
    return {
      orgName: s.orgName,
      contact: s.contact,
      candidateName: iv.candidate.displayName,
      scheduledAt: iv.scheduledAt,
      location: iv.location,
      minor: isMinor(iv.candidate),
      state: linkState(iv, link),
      expiresAt: link.expiresAt,
      consent: { ...rendered, version },
    };
  });

  r.post("/api/public/consent/:token", "none", async (c) => {
    const { iv: found } = lookup(app, c);
    const body = obj(await readJson(c, 64 * 1024));
    const recording = bool(body.recording, "録画への同意");
    const analysis = bool(body.analysis, "表情の計測への同意");
    if (analysis && !recording) throw new ValidationError("表情の計測には録画への同意が必要です");
    const candidateName = str(body.candidateName, "本人の氏名", { max: 60, min: 1 });
    const guardianName = str(body.guardianName, "保護者の氏名", { max: 60, optional: true });
    const guardianRelation = str(body.guardianRelation, "続柄", { max: 20, optional: true });
    const version = str(body.consentVersion, "同意文の版", { max: 20, min: 1 });

    const result = await store.withLock(found.id, async () => {
      const iv = getInterview(app, found.id);
      const link = iv.consentLinks.find((l) => l.tokenHash === hashToken(c.params.token));
      if (!link) throw new HttpError(404, "リンクが見つかりません");
      const state = linkState(iv, link);
      if (state !== "open") throw new HttpError(409, STATE_MESSAGE[state]);
      // 未成年は保護者の方が入力する
      if (isMinor(iv.candidate) && !guardianName) throw new ValidationError("保護者の方の氏名を入力してください");
      const { text, version: current } = renderedConsent(app);
      if (version !== current) {
        throw new HttpError(409, "説明の文面が更新されました。ページを読み込み直して、内容を確かめてから入力してください");
      }
      const now = new Date().toISOString();
      const consent: ConsentRecord = {
        recording,
        analysis,
        candidateName,
        guardianName: guardianName || null,
        guardianRelation: guardianRelation || null,
        method: "online",
        consentVersion: current,
        consentText: text,
        obtainedBy: link.createdBy,
        obtainedByName: link.createdByName,
        obtainedAt: now,
        withdrawnAt: null,
        withdrawnScope: null,
        linkId: link.id,
      };
      iv.consent = consent;
      iv.recordingDeclined = !recording;
      link.usedAt = now;
      await store.saveInterview(iv);
      return { iv, link };
    });
    await app.audit.write({
      userId: null,
      userName: "オンライン同意",
      action: "consent_online",
      interviewId: result.iv.id,
      detail: `recording=${recording} analysis=${analysis} link=${result.link.id}`,
      ip: c.ip,
    });
    void notifyConsentOnline(app, result.iv, recording, result.link.createdBy);
    return { ok: true, recording, analysis };
  });
}
