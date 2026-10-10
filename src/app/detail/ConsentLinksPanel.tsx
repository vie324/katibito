// 事前のオンライン同意: 本人・保護者に送るリンクを作り、その状態(未使用・入力済み・期限切れ・取り消し)を見る。
// リンクのトークンは作った直後にしか表示できない(サーバーにはハッシュしか残らない)。

import { useState } from "react";
import type { ConsentLink, InterviewDetail } from "../../shared/types";
import { api, errorMessage } from "../api";
import { QrCode } from "../components/QrCode";
import { formatDateTime } from "../format";
import { useConfirm, useToast } from "../ui";

type LinkState = "open" | "used" | "expired" | "revoked";

const STATE_LABEL: Record<LinkState, string> = {
  open: "未入力",
  used: "入力済み",
  expired: "期限切れ",
  revoked: "取り消し",
};

function stateOf(l: ConsentLink, now: number): LinkState {
  if (l.usedAt) return "used";
  if (l.revokedAt) return "revoked";
  return Date.parse(l.expiresAt) <= now ? "expired" : "open";
}

export function ConsentLinksPanel({ detail, setDetail }: { detail: InterviewDetail; setDetail: (d: InterviewDetail) => void }) {
  const iv = detail.interview;
  const toast = useToast();
  const [confirmNode, confirm] = useConfirm();
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; id: string } | null>(null);
  const canCreate = !iv.consent && !iv.decision;
  if (!canCreate && iv.consentLinks.length === 0) return null;
  const now = Date.now();

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createConsentLink(iv.id, days);
      setDetail(r.detail);
      setCreated({ url: `${window.location.origin}/c/${r.token}`, id: r.link.id });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (l: ConsentLink) => {
    const ok = await confirm({
      title: "リンクを取り消す",
      body: "このリンクから同意を入力できなくなります。送った相手にも、使えなくなったことを伝えてください。",
      ok: "取り消す",
      danger: true,
    });
    if (!ok) return;
    try {
      setDetail(await api.revokeConsentLink(iv.id, l.id));
      if (created?.id === l.id) setCreated(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      toast("リンクをコピーしました");
    } catch {
      toast("コピーできませんでした。表示されているリンクを選んでコピーしてください", "error");
    }
  };

  return (
    <section className="panel consent-links">
      {confirmNode}
      <div className="panel-title">事前のオンライン同意</div>
      <div className="pad">
        {canCreate && (
          <>
            <p className="muted small">
              面接の前に、本人・保護者にリンクを送って、録画と表情の計測への同意をスマートフォンなどで入力してもらえます。
              入力された内容は、この面接の同意として記録されます。当日の撮影の前にも、口頭で確認してください。
            </p>
            <div className="row-actions left">
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="リンクの有効期限">
                {[3, 7, 14, 30].map((d) => (
                  <option key={d} value={d}>
                    {d}日間有効
                  </option>
                ))}
              </select>
              <button className="primary" disabled={busy} onClick={() => void create()}>
                同意のリンクを作る
              </button>
            </div>
          </>
        )}
        {created && (
          <div className="link-created">
            <QrCode text={created.url} />
            <div className="grow">
              <div className="small">このリンク(または QR コード)を、本人・保護者に送ってください。</div>
              <div className="link-box">
                <input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="同意のリンク" />
                <button onClick={() => void copy()}>コピー</button>
              </div>
              <div className="warn-text small">
                リンクを知っている人は誰でも入力できます。本人・保護者以外に知られないようにしてください。
                このリンクは、この画面を離れると二度と表示できません(必要なら作り直してください)。
              </div>
            </div>
          </div>
        )}
        {iv.consentLinks.length > 0 && (
          <ul className="link-list">
            {iv.consentLinks
              .slice()
              .reverse()
              .map((l) => {
                const st = stateOf(l, now);
                return (
                  <li key={l.id}>
                    <span className={`link-state link-${st}`}>{STATE_LABEL[st]}</span>
                    <span className="muted small">
                      {formatDateTime(l.createdAt)} 作成({l.createdByName})・期限 {formatDateTime(l.expiresAt)}
                      {l.usedAt ? `・入力 ${formatDateTime(l.usedAt)}` : ""}
                    </span>
                    {st === "open" && (
                      <button className="quiet small danger-text" onClick={() => void revoke(l)}>
                        取り消す
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </section>
  );
}
