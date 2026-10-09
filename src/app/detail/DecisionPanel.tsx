// 判定(管理者)。面接官の評価を中心に、表情の計測は参考として並べる。

import { useState } from "react";
import type { ExpressionSummary } from "../../analysis/expression";
import { formatMetric, QUALITY_LABEL } from "../../analysis/metricsMeta";
import { VOTE_LABEL } from "../../shared/status";
import type { InterviewDetail, Vote } from "../../shared/types";
import { api } from "../api";
import { formatDateTime } from "../format";
import { useSession } from "../session";
import { Field, Notice, useAction, useConfirm, useToast, VoteChip } from "../ui";
import { Tally } from "./EvaluationPanel";

const VOTES: Vote[] = ["pass", "hold", "fail"];

export function DecisionPanel({
  detail,
  setDetail,
  summary,
}: {
  detail: InterviewDetail;
  setDetail: (d: InterviewDetail) => void;
  summary: ExpressionSummary | null;
}) {
  const { user } = useSession();
  const toast = useToast();
  const iv = detail.interview;
  const d = iv.decision;
  const isAdmin = user?.role === "admin";
  const [result, setResult] = useState<Vote | null>(null);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const [confirmNode, confirm] = useConfirm();

  const evals = [
    ...(detail.evaluations.mine?.status === "submitted" ? [detail.evaluations.mine] : []),
    ...(detail.evaluations.others ?? []),
  ];
  const expected = iv.interviewerIds.length;
  const submittedAssigned = evals.filter((e) => iv.interviewerIds.includes(e.userId)).length;

  const decide = async () => {
    if (!result) return;
    const ok = await confirm({
      title: `「${VOTE_LABEL[result]}」で確定しますか?`,
      body: (
        <p className="muted small">
          確定すると、評価は変更できなくなります(取り消して再判定はできます)。
          {expected > 0 && submittedAssigned < expected && ` 面接官 ${expected} 人中 ${submittedAssigned} 人しか評価を提出していません。`}
        </p>
      ),
      ok: "判定を確定する",
    });
    if (!ok) return;
    const res = await run(() => api.decide(iv.id, result, reason));
    if (res) {
      setDetail(res);
      toast("判定を確定しました");
    }
  };

  const cancel = async () => {
    const ok = await confirm({
      title: "判定を取り消しますか?",
      body: "取り消すと、評価の修正と再判定ができるようになります。",
      ok: "取り消す",
      danger: true,
    });
    if (!ok) return;
    const res = await run(() => api.cancelDecision(iv.id));
    if (res) setDetail(res);
  };

  return (
    <section className="panel decision" id="decision">
      {confirmNode}
      <div className="panel-title">判定</div>
      <div className="pad">
        {d ? (
          <div className="decided">
            <VoteChip vote={d.result} large />
            <div className="muted small">
              {d.decidedByName} ・ {formatDateTime(d.decidedAt)}
            </div>
            {d.reason && <div className="decision-reason">{d.reason}</div>}
            {isAdmin && (
              <div className="row-actions">
                <button className="quiet small" disabled={busy} onClick={() => void cancel()}>
                  判定を取り消す
                </button>
              </div>
            )}
          </div>
        ) : !isAdmin ? (
          <div className="muted">判定は管理者が行います。</div>
        ) : (
          <>
            <div className="decision-materials">
              <div className="muted small">
                評価の提出 {submittedAssigned}/{expected || "—"} 人
              </div>
              {detail.evaluations.othersVisible ? <Tally evaluations={evals} criteria={detail.criteria} /> : null}
              {summary && (
                <div className="decision-expr">
                  <div className="sub-head">表情の計測(参考)</div>
                  <div className="decision-expr-row">
                    <span>
                      表情の豊かさ <b className="num">{summary.quality.level === "low" || summary.overall.expressiveness === null ? "—" : Math.round(summary.overall.expressiveness)}</b>
                    </span>
                    <span>
                      笑顔の頻度 <b className="num">{formatMetric("smileRate", summary.overall.smileRate)}%</b>
                    </span>
                    <span>
                      笑顔の回数 <b className="num">{formatMetric("smilePerMin", summary.overall.smilePerMin)}回/分</b>
                    </span>
                    <span className={`conf-badge ${summary.quality.level}`}>信頼度 {QUALITY_LABEL[summary.quality.level]}</span>
                  </div>
                  <div className="muted small">表情の数値は補助的な記録です。面接官の評価を中心に判断してください。</div>
                </div>
              )}
            </div>
            <div className="vote-buttons" role="radiogroup" aria-label="判定">
              {VOTES.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={result === v}
                  className={`vote-btn vote-${v} ${result === v ? "on" : ""}`}
                  onClick={() => setResult(v)}
                >
                  {VOTE_LABEL[v]}
                </button>
              ))}
            </div>
            <Field label="判定の理由(記録用)">
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} />
            </Field>
            {error && <Notice kind="error">{error}</Notice>}
            <div className="row-actions">
              <button className="primary" disabled={!result || busy} onClick={() => void decide()}>
                判定を確定する
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
