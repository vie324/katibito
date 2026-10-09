// 合否通知書(管理者)。判定の結果に合わせた文面(設定 > 通知書)を差し込み、手直しして印刷する。

import { useEffect, useState } from "react";
import { renderNotice } from "../../shared/notice";
import { VOTE_LABEL } from "../../shared/status";
import type { InterviewDetail, Vote } from "../../shared/types";
import { api, errorMessage } from "../api";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Field, Loading, Notice } from "../ui";

function today(): string {
  return new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });
}

export default function NoticePage({ id }: { id: string }) {
  const { settings, info } = useSession();
  const { navigate } = useRouter();
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Vote>("pass");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [date, setDate] = useState(today());

  useEffect(() => {
    api
      .interview(id)
      .then((d) => {
        setDetail(d);
        if (d.interview.decision) setKind(d.interview.decision.result);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  useEffect(() => {
    if (!detail || !settings) return;
    const r = renderNotice(settings.notices[kind], detail.interview, settings);
    setTitle(r.title);
    setBody(r.body);
  }, [detail, settings, kind]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!detail || !settings) return <Loading />;
  const iv = detail.interview;

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <button className="quiet" onClick={() => navigate(`/interviews/${iv.id}`)}>
          ← 面接の詳細へ
        </button>
        <span className="spacer" />
        <button
          className="primary"
          onClick={() => {
            void api.recordPrinted(iv.id, "notice").catch(() => undefined);
            window.print();
          }}
        >
          印刷・PDF で保存
        </button>
      </div>
      {!iv.decision && <Notice kind="warn">まだ判定していません。判定を確定してから作成してください。</Notice>}
      <div className="notice-editor no-print panel pad form">
        <div className="grid2">
          <Field label="文面">
            <select value={kind} onChange={(e) => setKind(e.target.value as Vote)}>
              {(["pass", "fail", "hold"] as Vote[]).map((v) => (
                <option key={v} value={v}>
                  {VOTE_LABEL[v]}の文面{iv.decision?.result === v ? "(判定と同じ)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="日付">
            <input value={date} onChange={(e) => setDate(e.target.value)} maxLength={30} />
          </Field>
        </div>
        {iv.decision && kind !== iv.decision.result && <Notice kind="warn">判定({VOTE_LABEL[iv.decision.result]})と違う文面を選んでいます。</Notice>}
        <Field label="タイトル">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        </Field>
        <Field label="本文" hint="ここでの手直しは、この1通だけに反映されます(ひな形は「設定 > 通知書」)">
          <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>

      <article className="paper letter">
        <div className="letter-date">{date}</div>
        <div className="letter-from">{info?.orgName}</div>
        <h1>{title}</h1>
        <div className="letter-body pre">{body}</div>
      </article>
    </div>
  );
}
