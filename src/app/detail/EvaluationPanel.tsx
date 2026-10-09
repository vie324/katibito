// 評価の入力と、ほかの評価者の評価。
// 先入観を避けるため、自分の評価を提出するまでほかの人の評価・メモは表示しない(設定で変更可)。

import { useEffect, useState } from "react";
import { VOTE_LABEL } from "../../shared/status";
import { averageScore, formatScore, weightedScore } from "../../shared/score";
import type { Criterion, Evaluation, InterviewDetail, Vote } from "../../shared/types";
import { api } from "../api";
import { formatDateTime } from "../format";
import { useSession } from "../session";
import { Field, Notice, useAction, useConfirm, useToast, VoteChip } from "../ui";

const VOTES: Vote[] = ["pass", "hold", "fail"];

export function EvaluationPanel({ detail, setDetail }: { detail: InterviewDetail; setDetail: (d: InterviewDetail) => void }) {
  const { user } = useSession();
  const ev = detail.evaluations;
  const decided = !!detail.interview.decision;
  const [revealed, setRevealed] = useState(false);
  const showOthers = ev.othersVisible && (!ev.visibleBecauseAdmin || revealed);

  return (
    <section className="panel evaluation" id="evaluation">
      <div className="panel-title">評価</div>
      <div className="pad">
        <MyEvaluation detail={detail} setDetail={setDetail} />

        <h4 className="sub-head">
          ほかの評価者
          <span className="muted small">(提出 {ev.othersSubmittedCount}人)</span>
        </h4>
        {!ev.othersVisible && <Notice kind="info">{ev.hiddenReason}</Notice>}
        {ev.othersVisible && ev.visibleBecauseAdmin && !revealed && (
          <div className="reveal">
            <p className="muted small">
              自分の評価を先に入れる場合は、提出するまで表示しないでおくと先入観が入りません。
            </p>
            <button onClick={() => setRevealed(true)}>ほかの評価者の評価を表示する</button>
          </div>
        )}
        {showOthers && ev.others && (
          <>
            {ev.others.length === 0 ? (
              <div className="muted small">まだ提出された評価はありません。</div>
            ) : (
              <>
                <Tally
                  evaluations={[...(ev.mine?.status === "submitted" ? [ev.mine] : []), ...ev.others]}
                  criteria={detail.criteria}
                  passLine={detail.interview.passLine}
                />
                <div className="other-evals">
                  {ev.others.map((o) => (
                    <EvaluationCard key={o.userId} e={o} criteria={detail.criteria} labels={detail.ratingLabels} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {decided && user?.role !== "admin" && <div className="muted small">判定が確定したため、評価は変更できません。</div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 自分の評価
// ---------------------------------------------------------------------------

function MyEvaluation({ detail, setDetail }: { detail: InterviewDetail; setDetail: (d: InterviewDetail) => void }) {
  const toast = useToast();
  const mine = detail.evaluations.mine;
  const decided = !!detail.interview.decision;
  const criteria = detail.criteria;
  const labels = detail.ratingLabels;
  const [editing, setEditing] = useState(!mine || mine.status === "draft");
  const [ratings, setRatings] = useState<Record<string, number | null>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openComment, setOpenComment] = useState<Record<string, boolean>>({});
  const [vote, setVote] = useState<Vote | null>(null);
  const [comment, setComment] = useState("");
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useAction();
  const [confirmNode, confirm] = useConfirm();

  useEffect(() => {
    const r: Record<string, number | null> = {};
    for (const c of criteria) r[c.id] = mine?.ratings[c.id] ?? null;
    setRatings(r);
    setComments({ ...(mine?.criterionComments ?? {}) });
    setOpenComment(Object.fromEntries(Object.keys(mine?.criterionComments ?? {}).map((k) => [k, true])));
    setVote(mine?.vote ?? null);
    setComment(mine?.comment ?? "");
    setDirty(false);
    // 保存後にサーバーの内容で置き換える
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.updatedAt, criteria]);

  const missing = criteria.filter((c) => !ratings[c.id]).map((c) => c.label);
  const canSubmit = missing.length === 0 && vote !== null;
  const score = weightedScore(criteria, ratings);

  const save = async (submit: boolean) => {
    if (submit) {
      const ok = await confirm({
        title: "評価を提出しますか?",
        body: (
          <>
            <p>
              総合評価: <strong>{vote ? VOTE_LABEL[vote] : "—"}</strong>
            </p>
            <p className="muted small">提出すると、ほかの評価者の評価とメモが表示されます。判定が確定するまでは修正できます。</p>
          </>
        ),
        ok: "提出する",
      });
      if (!ok) return;
    }
    const res = await run(() =>
      api.saveEvaluation(detail.interview.id, { ratings, criterionComments: comments, vote, comment, submit }),
    );
    if (res) {
      setDetail(res);
      setDirty(false);
      if (submit) setEditing(false);
      toast(submit ? "評価を提出しました" : "下書きを保存しました");
    }
  };

  // 入力途中で画面を閉じてしまわないように
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (!editing && mine) {
    return (
      <div className="my-eval">
        {confirmNode}
        <div className="my-eval-head">
          <h4 className="sub-head">あなたの評価</h4>
          <span className="badge">{mine.status === "submitted" ? `提出済み ${formatDateTime(mine.submittedAt)}` : "下書き"}</span>
          <span className="spacer" />
          {!decided && (
            <button className="quiet" onClick={() => setEditing(true)}>
              修正する
            </button>
          )}
        </div>
        <EvaluationCard e={mine} criteria={criteria} labels={labels} hideName />
      </div>
    );
  }

  if (decided) {
    return <Notice kind="info">判定が確定しているため、評価は入力できません。</Notice>;
  }

  const mark = () => setDirty(true);

  return (
    <div className="my-eval">
      {confirmNode}
      <div className="my-eval-head">
        <h4 className="sub-head">あなたの評価</h4>
        {mine?.status === "submitted" && <span className="badge">提出済みの評価を修正中</span>}
        {mine?.status === "draft" && <span className="badge">下書き {formatDateTime(mine.updatedAt)}</span>}
      </div>
      <div className="criteria">
        {criteria.map((c) => (
          <div key={c.id} className="criterion">
            <div className="criterion-head">
              <span className="criterion-label">{c.label}</span>
              {c.description && <span className="muted small">{c.description}</span>}
            </div>
            <div className="scale" role="radiogroup" aria-label={c.label}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={ratings[c.id] === n}
                  className={`scale-btn ${ratings[c.id] === n ? "on" : ""}`}
                  onClick={() => {
                    setRatings({ ...ratings, [c.id]: n });
                    mark();
                  }}
                  title={labels[n - 1]}
                >
                  <span className="num">{n}</span>
                  <span className="scale-label">{labels[n - 1]}</span>
                </button>
              ))}
              <button
                type="button"
                className="quiet small"
                onClick={() => setOpenComment({ ...openComment, [c.id]: !openComment[c.id] })}
              >
                {openComment[c.id] ? "コメントを閉じる" : "コメント"}
              </button>
            </div>
            {openComment[c.id] && (
              <textarea
                rows={2}
                value={comments[c.id] ?? ""}
                onChange={(e) => {
                  setComments({ ...comments, [c.id]: e.target.value });
                  mark();
                }}
                placeholder={`${c.label}について(任意)`}
                maxLength={1000}
              />
            )}
          </div>
        ))}
      </div>

      <div className="score-line">
        <span className="muted small">合計点(重み付き平均)</span>
        <span className="num score-value">{formatScore(score)}</span>
        {missing.length > 0 && score !== null && <span className="muted small">(入力済みの項目だけで計算)</span>}
      </div>

      <div className="vote-select">
        <span className="criterion-label">総合評価</span>
        <div className="vote-buttons" role="radiogroup" aria-label="総合評価">
          {VOTES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={vote === v}
              className={`vote-btn vote-${v} ${vote === v ? "on" : ""}`}
              onClick={() => {
                setVote(v);
                mark();
              }}
            >
              {VOTE_LABEL[v]}
            </button>
          ))}
        </div>
      </div>
      <Field label="コメント">
        <textarea
          rows={4}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            mark();
          }}
          placeholder="判断の理由、気になった点、確認したいこと など"
          maxLength={4000}
        />
      </Field>

      {error && <Notice kind="error">{error}</Notice>}
      {!canSubmit && (
        <div className="muted small">
          提出するには{missing.length > 0 ? `「${missing.join("」「")}」` : ""}
          {missing.length > 0 && vote === null ? "と" : ""}
          {vote === null ? "総合評価" : ""}を選んでください。
        </div>
      )}
      <div className="row-actions">
        {mine?.status === "submitted" && (
          <button className="quiet" onClick={() => setEditing(false)}>
            修正をやめる
          </button>
        )}
        <span className="spacer" />
        {mine?.status !== "submitted" && (
          <button disabled={busy} onClick={() => void save(false)}>
            下書き保存
          </button>
        )}
        <button className="primary" disabled={busy || !canSubmit} onClick={() => void save(true)}>
          {mine?.status === "submitted" ? "修正を提出する" : "提出する"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

export function EvaluationCard({
  e,
  criteria,
  labels,
  hideName,
}: {
  e: Evaluation;
  criteria: Criterion[];
  labels: string[];
  hideName?: boolean;
}) {
  return (
    <div className="eval-card">
      {!hideName && (
        <div className="eval-card-head">
          <span className="eval-name">{e.userName}</span>
          {e.vote && <VoteChip vote={e.vote} />}
          <span className="num eval-score" title="合計点(重み付き平均)">{formatScore(weightedScore(criteria, e.ratings))}点</span>
          <span className="muted small">{formatDateTime(e.submittedAt ?? e.updatedAt)}</span>
        </div>
      )}
      {hideName && e.vote && (
        <div className="eval-card-head">
          <VoteChip vote={e.vote} />
          <span className="num eval-score" title="合計点(重み付き平均)">{formatScore(weightedScore(criteria, e.ratings))}点</span>
        </div>
      )}
      {(e.revisions ?? 0) > 0 && (
        <div className={`eval-revised small ${e.revisedWhileOthersVisible ? "warn-text" : "muted"}`}>
          提出後に修正あり({e.revisions}回、最終 {formatDateTime(e.revisedAt ?? e.updatedAt)})
          {e.revisedWhileOthersVisible ? "。ほかの評価者の評価が見える状態での修正を含みます" : ""}
        </div>
      )}
      <table className="eval-table">
        <tbody>
          {criteria.map((c) => {
            const r = e.ratings[c.id];
            return (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td className="num rating">
                  {r ? (
                    <>
                      <span className="pips">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <i key={n} className={n <= r ? "on" : ""} />
                        ))}
                      </span>
                      {r} <span className="muted small">{labels[r - 1]}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">{e.criterionComments[c.id] ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {e.comment && <div className="eval-comment">{e.comment}</div>}
    </div>
  );
}

export function Tally({
  evaluations,
  criteria,
  passLine,
}: {
  evaluations: Evaluation[];
  criteria: Criterion[];
  passLine?: number | null;
}) {
  const submitted = evaluations.filter((e) => e.status === "submitted");
  const votes: Record<Vote, number> = { pass: 0, hold: 0, fail: 0 };
  for (const e of submitted) if (e.vote) votes[e.vote]++;
  if (submitted.length === 0) return null;
  const score = averageScore(criteria, submitted);
  const weighted = criteria.some((c) => c.weight !== 1);
  return (
    <div className="tally">
      <div className="tally-votes">
        {VOTES.map((v) => (
          <div key={v} className={`tally-vote vote-${v}`}>
            <span>{VOTE_LABEL[v]}</span>
            <span className="num big">{votes[v]}</span>
          </div>
        ))}
        <div className="tally-vote tally-score">
          <span>合計点の平均{weighted ? "(重み付き)" : ""}</span>
          <span className="num big">{formatScore(score)}</span>
          {typeof passLine === "number" && score !== null && (
            <span className={`small ${score >= passLine ? "ok-text" : "warn-text"}`}>
              合格の目安 {passLine.toFixed(1)} {score >= passLine ? "以上" : "未満"}
            </span>
          )}
        </div>
      </div>
      <table className="tally-table">
        <thead>
          <tr>
            <th>項目</th>
            <th>平均</th>
            <th>最小〜最大</th>
          </tr>
        </thead>
        <tbody>
          {criteria.map((c) => {
            const xs = submitted.map((e) => e.ratings[c.id]).filter((x): x is number => typeof x === "number");
            const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
            const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
            return (
              <tr key={c.id}>
                <td>
                  {c.label}
                  {weighted && <span className="muted small"> ×{c.weight}</span>}
                </td>
                <td className="num">
                  {avg === null ? "—" : avg.toFixed(1)}
                  {avg !== null && (
                    <span className="avg-bar">
                      <span style={{ width: `${(avg / 5) * 100}%` }} />
                    </span>
                  )}
                </td>
                <td className={`num ${spread >= 2 ? "warn-text" : ""}`}>
                  {xs.length ? `${Math.min(...xs)}〜${Math.max(...xs)}` : "—"}
                  {spread >= 2 && <span className="small">(意見が分かれています)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {submitted.some((e) => e.revisedWhileOthersVisible) && (
        <div className="small warn-text">
          提出後に、ほかの評価者の評価が見える状態で修正された評価が{" "}
          {submitted.filter((e) => e.revisedWhileOthersVisible).length} 件あります(各評価の表示を確認してください)
        </div>
      )}
    </div>
  );
}
