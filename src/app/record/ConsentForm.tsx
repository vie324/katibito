// 同意の取得。録画と表情の計測は別々に同意を取る(録画だけ同意、もありうる)。
// 画面を候補者・保護者に向けて読んでもらうか、紙の同意書で取得済みとして記録する。

import { useState } from "react";
import { consentSnapshot, renderConsentText } from "../../shared/consent";
import type { Interview, InterviewDetail, Settings } from "../../shared/types";
import { api } from "../api";
import { Field, Notice, useAction } from "../ui";

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
  const minor = interview.candidate.minor;
  const [method, setMethod] = useState<"onscreen" | "paper">("onscreen");
  const [recording, setRecording] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const { busy, error, run } = useAction();

  const namesOk = candidateName.trim().length > 0 && (!minor || guardianName.trim().length > 0);

  const submit = async (agree: boolean) => {
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

  return (
    <div className="consent">
      <div className="consent-method">
        <label className="check">
          <input type="radio" checked={method === "onscreen"} onChange={() => setMethod("onscreen")} />
          <span>この画面を見せて同意を得る</span>
        </label>
        <label className="check">
          <input type="radio" checked={method === "paper"} onChange={() => setMethod("paper")} />
          <span>紙の同意書で取得済み(内容を転記する)</span>
        </label>
      </div>

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
          <span>面接の録画に同意します</span>
        </label>
        <label className={`check big ${recording ? "" : "disabled"}`}>
          <input type="checkbox" checked={analysis} disabled={!recording} onChange={(e) => setAnalysis(e.target.checked)} />
          <span>録画からの表情の計測に同意します</span>
        </label>

        <div className="grid2">
          <Field label="ご本人のお名前" required={recording}>
            <input value={candidateName} onChange={(e) => setCandidateName(e.target.value)} maxLength={60} />
          </Field>
          {minor && (
            <Field label="保護者のお名前" required={recording} hint="未成年の方は保護者の同意が必要です">
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
    </div>
  );
}
