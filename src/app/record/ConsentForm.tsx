// 同意の取得。録画と表情の計測は別々に同意を取る(録画だけ同意、もありうる)。
// 対面: 画面を候補者・保護者に向けて読んでもらうか、紙の同意書で取得済みとして記録する。
// オンライン面接(Google Meet): 同意のリンクを Meet のチャットに貼って本人・保護者の端末で回答してもらうか、
// 同意文を読み上げて(画面を共有して)口頭で確認し、聞き取った内容を記録する。

import { useEffect, useRef, useState } from "react";
import { consentSnapshot, renderConsentText } from "../../shared/consent";
import type { Interview, InterviewDetail, Settings } from "../../shared/types";
import { api, errorMessage } from "../api";
import { Field, Notice, useAction, useToast } from "../ui";

type Method = "onscreen" | "paper" | "verbal" | "link";

export function ConsentForm({
  interview,
  settings,
  onRecorded,
  onCancel,
}: {
  interview: Interview;
  settings: Settings;
  onRecorded: (d: InterviewDetail) => void;
  onCancel?: () => void;
}) {
  const rendered = renderConsentText(settings);
  const minor = interview.candidate.minor || (interview.candidate.age !== null && interview.candidate.age < 18);
  const online = interview.format === "online";
  // 同意の記録(「録画しない」など)がすでにある面接は、リンクでは取り直せない(口頭か紙で記録する)
  const hasPrior = !!interview.consent;
  const [method, setMethod] = useState<Method>(online ? (hasPrior ? "verbal" : "link") : "onscreen");
  const [recording, setRecording] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const { busy, error, run } = useAction();

  const namesOk = candidateName.trim().length > 0 && (!minor || guardianName.trim().length > 0);

  const submit = async (agree: boolean) => {
    if (method === "link") return;
    const res = await run(() =>
      api.recordConsent(interview.id, {
        recording: agree && recording,
        analysis: agree && recording && analysis,
        candidateName: agree ? candidateName : candidateName || "",
        guardianName: agree ? guardianName : "",
        guardianRelation: agree ? guardianRelation : "",
        method,
        consentText: consentSnapshot(rendered),
      }),
    );
    if (res) onRecorded(res);
  };

  const options: { value: Method; label: string; disabled?: boolean }[] = online
    ? [
        {
          value: "link",
          label: hasPrior
            ? "同意のリンクを Meet のチャットで送る(同意の記録があるため使えません)"
            : "同意のリンクを Meet のチャットで送る(本人・保護者が自分の端末で読んで回答。おすすめ)",
          disabled: hasPrior,
        },
        { value: "verbal", label: "同意文を読み上げて(画面を共有して)、口頭で確認する" },
        { value: "paper", label: "紙の同意書で取得済み(内容を転記する)" },
      ]
    : [
        { value: "onscreen", label: "この画面を見せて同意を得る" },
        { value: "paper", label: "紙の同意書で取得済み(内容を転記する)" },
      ];
  const verbal = method === "verbal";

  return (
    <div className="consent">
      {online && <Notice kind="info">オンライン面接(Google Meet)です。候補者がこの画面を見られないため、次のどれかの方法で同意を確かめてください。</Notice>}
      <div className="consent-method">
        {options.map((o) => (
          <label key={o.value} className={`check ${o.disabled ? "disabled" : ""}`}>
            <input
              type="radio"
              name="consent-method"
              checked={method === o.value}
              disabled={o.disabled}
              onChange={() => setMethod(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>

      {method === "link" ? (
        <OnlineConsentLink interview={interview} orgName={settings.orgName} onRecorded={onRecorded} onCancel={onCancel} />
      ) : (
        <>
          {verbal && (
            <Notice kind="info">
              次の同意文を読み上げるか、Meet の「画面を共有」でこの画面を見せながら、本人{minor ? "と保護者" : ""}
              に録画と表情の計測のそれぞれについて同意するか確かめ、聞き取った内容を入力してください。
              録画を始めたら、同意いただいたことを口頭でもう一度確かめると、確かめたことが録画にも残ります。
            </Notice>
          )}
          <div className="consent-doc">
            <h2>{rendered.title}</h2>
            {rendered.body.split("\n").map((line, i) => (line.trim() === "" ? <br key={i} /> : <p key={i}>{line}</p>))}
          </div>

          <div className="consent-answers">
            <label className="check big">
              <input
                type="checkbox"
                checked={recording}
                onChange={(e) => {
                  setRecording(e.target.checked);
                  if (!e.target.checked) setAnalysis(false);
                }}
              />
              <span>{verbal ? "面接の録画に同意すると口頭で確認した" : "面接の録画に同意します"}</span>
            </label>
            <label className={`check big ${recording ? "" : "disabled"}`}>
              <input type="checkbox" checked={analysis} disabled={!recording} onChange={(e) => setAnalysis(e.target.checked)} />
              <span>{verbal ? "録画からの表情の計測に同意すると口頭で確認した" : "録画からの表情の計測に同意します"}</span>
            </label>

            <div className="grid2">
              <Field label={verbal ? "ご本人のお名前(聞き取った名前)" : "ご本人のお名前"} required={recording}>
                <input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} maxLength={60} />
              </Field>
              {minor && (
                <Field label={verbal ? "保護者のお名前(聞き取った名前)" : "保護者のお名前"} required={recording} hint="未成年の方は保護者の同意が必要です">
                  <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} maxLength={60} />
                </Field>
              )}
            </div>
            {minor && (
              <Field label="続柄">
                <input value={guardianRelation} onChange={(e) => setGuardianRelation(e.target.value)} maxLength={20} placeholder="母、父 など" />
              </Field>
            )}
          </div>

          <Notice kind="info">
            同意いただけない場合も、面接は通常どおり行います。その場合は「録画しないで面接する」を選んでください(面接官の評価だけを記録します)。
          </Notice>
          {error && <Notice kind="error">{error}</Notice>}

          <div className="row-actions">
            {onCancel && (
              <button className="quiet" onClick={onCancel}>
                戻る
              </button>
            )}
            <span className="spacer" />
            <button className="quiet" disabled={busy} onClick={() => void submit(false)}>
              録画しないで面接する
            </button>
            <button className="primary" disabled={busy || !recording || !namesOk} onClick={() => void submit(true)}>
              同意を記録して撮影の準備へ
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * オンライン面接: その場で同意のリンクを作り、Meet のチャットに貼る文面を用意する。
 * 本人・保護者が回答すると(数秒ごとに確かめて)自動で次に進む。
 */
function OnlineConsentLink({
  interview,
  orgName,
  onRecorded,
  onCancel,
}: {
  interview: Interview;
  orgName: string;
  onRecorded: (d: InterviewDetail) => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const openLinks = interview.consentLinks.filter((l) => !l.usedAt && !l.revokedAt && Date.parse(l.expiresAt) > Date.now()).length;

  // 回答が届いたら次へ(事前に送ったリンクへの回答も含む)。前からある記録は回答とみなさない
  const recordedRef = useRef(onRecorded);
  recordedRef.current = onRecorded;
  const priorAt = interview.consent?.obtainedAt ?? null;
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const d = await api.interview(interview.id);
        if (alive && d.interview.consent && d.interview.consent.obtainedAt !== priorAt) {
          alive = false;
          recordedRef.current(d);
        }
      } catch {
        // 通信できないときは次の周期で
      }
    };
    const t = setInterval(() => void check(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [interview.id, priorAt]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      // その場で使うリンクなので、有効期限は短く(1日)
      const r = await api.createConsentLink(interview.id, 1);
      setUrl(`${window.location.origin}/c/${r.token}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const message = url
    ? `【${orgName.trim() || "面接の担当者"}】面接の録画についての同意のお願いです。次のリンクを開き、内容をお読みのうえご回答ください${
        interview.candidate.minor || (interview.candidate.age !== null && interview.candidate.age < 18) ? "(保護者の方がご回答ください)" : ""
      }。\n${url}`
    : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast("コピーしました。Meet のチャットに貼り付けて送ってください");
    } catch {
      // クリップボードを使えない環境: 選択状態にして手でコピーしてもらう
      textRef.current?.select();
      toast("コピーできませんでした。選択した文面をコピーしてください", "error");
    }
  };

  return (
    <div className="panel pad consent-online">
      {openLinks > 0 && !url && (
        <Notice kind="info">
          事前に送ったリンク(未回答)が {openLinks} 件あります。そのリンクから回答が届いても、自動で次に進みます。
        </Notice>
      )}
      {!url ? (
        <>
          <p>
            同意のリンクを作り、Meet のチャットに貼り付けて送ります。本人・保護者がスマートフォンやパソコンで同意文を読み、録画と表情の計測のそれぞれに回答します。
          </p>
          <div className="row-actions left">
            <button className="primary" disabled={busy} onClick={() => void create()}>
              {busy ? "作成しています…" : "同意のリンクを作る"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>次の文面をコピーして、Meet のチャットに貼り付けて送ってください(リンクの有効期限は1日です)。</p>
          <textarea ref={textRef} className="copy-box" readOnly value={message} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions left">
            <button className="primary" onClick={() => void copy()}>
              文面をコピー
            </button>
          </div>
        </>
      )}
      <p className="waiting" role="status">
        回答を待っています。回答が届くと、自動で次に進みます。
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {onCancel && (
        <div className="row-actions">
          <button className="quiet" onClick={onCancel}>
            戻る
          </button>
        </div>
      )}
    </div>
  );
}
