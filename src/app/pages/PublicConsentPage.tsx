// 事前のオンライン同意(ログイン不要)。担当者から届いたリンク /c/<トークン> を本人・保護者が開いて入力する。
// 録画と表情の計測は別々に答えてもらう。同意しなくても面接は通常どおり行うことを明記する。

import { useEffect, useState } from "react";
import type { PublicConsentInfo } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { Field, Loading, Notice } from "../ui";

type Answer = "yes" | "no" | null;

export default function PublicConsentPage({ token }: { token: string }) {
  const [info, setInfo] = useState<PublicConsentInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Answer>(null);
  const [analysis, setAnalysis] = useState<Answer>(null);
  const [candidateName, setCandidateName] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ recording: boolean; analysis: boolean } | null>(null);

  useEffect(() => {
    document.title = "同意のお願い";
    api
      .publicConsent(token)
      .then((i) => {
        setInfo(i);
        if (i.orgName) document.title = `同意のお願い — ${i.orgName}`;
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [token]);

  if (loadError) {
    return (
      <div className="public-page">
        <Notice kind="error">{loadError}</Notice>
      </div>
    );
  }
  if (!info) return <Loading />;

  const contact = info.contact.trim() || "面接の担当者";
  // 面接の情報は、入力できるリンク(open)のときだけ届く
  const d = info.details;
  const ready =
    !!d &&
    recording !== null &&
    (recording === "no" || analysis !== null) &&
    candidateName.trim().length > 0 &&
    (!d.minor || guardianName.trim().length > 0) &&
    read;

  const submit = async () => {
    if (!ready || !d) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.submitPublicConsent(token, {
        recording: recording === "yes",
        analysis: recording === "yes" && analysis === "yes",
        candidateName: candidateName.trim(),
        guardianName: guardianName.trim(),
        guardianRelation: guardianRelation.trim(),
        consentVersion: d.consent.version,
      });
      setDone({ recording: r.recording, analysis: r.analysis });
      window.scrollTo(0, 0);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <header className="public-head">
      <div className="public-org">{info.orgName}</div>
      <h1>面接の録画についての同意のお願い</h1>
      {d && (
        <dl className="public-facts">
          <dt>面接を受ける方</dt>
          <dd>{d.candidateName} 様</dd>
          {d.scheduledAt && (
            <>
              <dt>面接の日時</dt>
              <dd>{formatDateTime(d.scheduledAt)}</dd>
            </>
          )}
          {d.location && (
            <>
              <dt>場所</dt>
              <dd>{d.location}</dd>
            </>
          )}
        </dl>
      )}
    </header>
  );

  if (done) {
    return (
      <div className="public-page">
        {head}
        <Notice kind="ok">ご回答ありがとうございました。内容を記録しました。</Notice>
        <ul className="public-summary">
          <li>面接の録画: {done.recording ? "同意する" : "同意しない"}</li>
          {done.recording && <li>録画からの表情の計測: {done.analysis ? "同意する" : "同意しない"}</li>}
        </ul>
        <p className="small">
          面接の当日にも、撮影の前に確認させていただきます。同意を取り消したい・変更したい場合は、いつでも {contact} までご連絡ください。
        </p>
        <p className="muted small">このページは閉じてかまいません。</p>
      </div>
    );
  }

  if (info.state !== "open" || !d) {
    return (
      <div className="public-page">
        {head}
        <Notice kind={info.state === "done" ? "ok" : "warn"}>
          {info.state === "done"
            ? "同意の記録はすでに済んでいます。"
            : info.state === "expired"
              ? "このリンクの有効期限が切れています。"
              : "このリンクは使えなくなっています。"}
        </Notice>
        <p className="small">変更・取り消し・ご質問は、{contact} までご連絡ください。</p>
      </div>
    );
  }

  return (
    <div className="public-page">
      {head}
      <p className="small">
        下の説明をお読みいただき、録画と表情の計測について、それぞれ同意いただけるかをお答えください。
        <b>同意いただけない場合も、面接は通常どおり行います。</b>回答によって選考で不利になることはありません。
      </p>

      <div className="consent-doc public-doc">
        <h2>{d.consent.title}</h2>
        {d.consent.body.split("\n").map((line, i) => (line.trim() === "" ? <br key={i} /> : <p key={i}>{line}</p>))}
      </div>

      <div className="public-form form">
        <fieldset className="public-q">
          <legend>面接の録画に同意しますか</legend>
          <label className="check big">
            <input type="radio" name="rec" checked={recording === "yes"} onChange={() => setRecording("yes")} />
            <span>同意する</span>
          </label>
          <label className="check big">
            <input
              type="radio"
              name="rec"
              checked={recording === "no"}
              onChange={() => {
                setRecording("no");
                setAnalysis(null);
              }}
            />
            <span>同意しない(録画せずに面接します)</span>
          </label>
        </fieldset>

        {recording === "yes" && (
          <fieldset className="public-q">
            <legend>録画からの表情の計測に同意しますか</legend>
            <label className="check big">
              <input type="radio" name="ana" checked={analysis === "yes"} onChange={() => setAnalysis("yes")} />
              <span>同意する</span>
            </label>
            <label className="check big">
              <input type="radio" name="ana" checked={analysis === "no"} onChange={() => setAnalysis("no")} />
              <span>同意しない(録画だけにします)</span>
            </label>
          </fieldset>
        )}

        <Field label="面接を受ける方のお名前" required>
          <input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} maxLength={60} autoComplete="off" />
        </Field>
        {d.minor && (
          <>
            <Field label="保護者の方のお名前" required hint="未成年の方は、保護者の方がご回答ください">
              <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} maxLength={60} autoComplete="name" />
            </Field>
            <Field label="続柄">
              <input value={guardianRelation} onChange={(e) => setGuardianRelation(e.target.value)} maxLength={20} placeholder="母、父 など" />
            </Field>
          </>
        )}

        <label className="check">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
          <span>上の説明を読み、内容を理解しました</span>
        </label>

        {error && <Notice kind="error">{error}</Notice>}
        <button className="primary public-submit" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "送信中…" : "この内容で回答する"}
        </button>
        <p className="muted small">
          回答の有効期限: {formatDateTime(d.expiresAt)} まで。ご不明な点は {contact} までお問い合わせください。
        </p>
      </div>
    </div>
  );
}
