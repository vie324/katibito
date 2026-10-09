// 面接記録票(印刷・PDF 保存用)。候補者・同意・評価・判定・表情の計測(参考)・メモ・文字起こしを1つの文書にまとめる。
// 評価とメモは、画面と同じ非公開のルールで見えるものだけを載せる。

import { useEffect, useMemo, useState } from "react";
import { pickRepresentative, type ExpressionSummary } from "../../analysis/expression";
import { formatMetric, METRIC_META, PRIMARY_METRICS, QUALITY_LABEL } from "../../analysis/metricsMeta";
import { averageScore, criterionAverages, formatScore, weightedScore } from "../../shared/score";
import { STATUS_LABEL, VOTE_LABEL } from "../../shared/status";
import type { Evaluation, InterviewDetail, Note, Transcript, Vote } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatClock, formatDate, formatDateTime } from "../format";
import { useRouter } from "../router";
import { useSession } from "../session";
import { Loading, Notice } from "../ui";

const VOTES: Vote[] = ["pass", "hold", "fail"];

export default function ReportPage({ id }: { id: string }) {
  const { user, info } = useSession();
  const { navigate } = useRouter();
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [summary, setSummary] = useState<ExpressionSummary | null>(null);
  const [transcripts, setTranscripts] = useState<{ label: string; t: Transcript }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [withNotes, setWithNotes] = useState(true);
  const [withTranscript, setWithTranscript] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.interview(id);
        if (!alive) return;
        setDetail(d);
        const analyzed = d.interview.recordings.filter((r) => r.analysis === "ready");
        const list = await Promise.all(analyzed.map((r) => api.summary(id, r.id).then((x) => x.summary).catch(() => null)));
        if (alive) setSummary(pickRepresentative(list.filter((x): x is ExpressionSummary => !!x)));
        const recs = d.interview.recordings.filter((r) => r.transcript === "ready");
        const ts = await Promise.all(
          recs.map((r, i) =>
            api
              .transcript(id, r.id)
              .then((x) => ({ label: recs.length > 1 ? `録画${i + 1}` : "", t: x.transcript }))
              .catch(() => null),
          ),
        );
        if (alive) setTranscripts(ts.filter((x): x is { label: string; t: Transcript } => !!x));
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const evals: Evaluation[] = useMemo(() => {
    if (!detail) return [];
    const e = detail.evaluations;
    return [...(e.mine?.status === "submitted" ? [e.mine] : []), ...(e.othersVisible && e.others ? e.others : [])];
  }, [detail]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!detail) return <Loading />;

  const iv = detail.interview;
  const c = iv.consent;
  const criteria = detail.criteria;
  const avgs = criterionAverages(criteria, evals);
  const score = averageScore(criteria, evals);
  const votes: Record<Vote, number> = { pass: 0, hold: 0, fail: 0 };
  for (const e of evals) if (e.vote) votes[e.vote]++;
  const notes: Note[] = detail.notes.notes.filter((n) => n.kind !== "room");
  const recIndex = new Map(iv.recordings.map((r, i) => [r.id, i]));

  const print = () => {
    void api.recordPrinted(iv.id, "report").catch(() => undefined);
    window.print();
  };

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <button className="quiet" onClick={() => navigate(`/interviews/${iv.id}`)}>
          ← 面接の詳細へ
        </button>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={withNotes} onChange={(e) => setWithNotes(e.target.checked)} />
          <span>メモを含める</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={withTranscript} disabled={transcripts.length === 0} onChange={(e) => setWithTranscript(e.target.checked)} />
          <span>文字起こしを含める{transcripts.length === 0 ? "(なし)" : ""}</span>
        </label>
        <button className="primary" onClick={print}>
          印刷・PDF で保存
        </button>
      </div>
      <p className="no-print muted small print-hint">
        印刷の画面で「送信先」を「PDF に保存」にすると PDF になります。個人情報を含むため、保管と廃棄に注意してください。
      </p>

      <article className="paper">
        <header className="paper-head">
          <div className="paper-org">{info?.orgName}</div>
          <h1>面接記録票</h1>
          <div className="paper-meta">
            作成 {formatDateTime(new Date().toISOString())} ・ {user?.name} ・ 取り扱い注意(個人情報)
          </div>
        </header>

        <section>
          <h2>候補者と面接</h2>
          <table className="paper-table">
            <tbody>
              <tr>
                <th>候補者</th>
                <td>
                  {iv.candidate.displayName}
                  {iv.candidate.kana ? `(${iv.candidate.kana})` : ""}
                  {iv.candidate.age !== null ? ` ・ ${iv.candidate.age}歳` : ""}
                  {iv.candidate.minor ? " ・ 未成年" : ""}
                </td>
              </tr>
              <tr>
                <th>面接</th>
                <td>
                  {iv.round ? `${iv.round} ・ ` : ""}
                  {formatDateTime(iv.scheduledAt ?? iv.createdAt)}
                  {iv.location ? ` ・ ${iv.location}` : ""}
                </td>
              </tr>
              <tr>
                <th>面接官</th>
                <td>{detail.interviewers.map((u) => u.name).join("、") || "—"}</td>
              </tr>
              <tr>
                <th>評価シート</th>
                <td>{iv.templateName || "—"}</td>
              </tr>
              <tr>
                <th>状態</th>
                <td>{iv.decision ? `判定済み(${VOTE_LABEL[iv.decision.result]})` : STATUS_LABEL[detail.status]}</td>
              </tr>
              <tr>
                <th>同意</th>
                <td>
                  {!c
                    ? "未取得"
                    : c.recording
                      ? `録画 あり ・ 表情の計測 ${c.analysis ? "あり" : "なし"}(${c.method === "paper" ? "紙の同意書" : c.method === "online" ? "オンライン" : "画面で取得"}・${formatDate(c.obtainedAt)}${c.guardianName ? `・保護者 ${c.guardianName}` : ""})`
                      : "録画なし(同意を得られなかったため)"}
                  {c?.withdrawnAt ? ` ・ ${formatDate(c.withdrawnAt)} に取り消し(${c.withdrawnScope === "all" ? "すべて" : "表情の計測"})` : ""}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>評価の集計</h2>
          {!detail.evaluations.othersVisible && (
            <p className="paper-note">ほかの評価者の評価は、自分の評価を提出するまで載りません(評価の非公開の設定)。</p>
          )}
          {evals.length === 0 ? (
            <p className="paper-note">提出された評価はありません。</p>
          ) : (
            <>
              <p>
                {VOTES.map((v) => `${VOTE_LABEL[v]} ${votes[v]}`).join(" ・ ")} ・ 合計点の平均 {formatScore(score)}
                {iv.passLine !== null && score !== null ? `(合格の目安 ${iv.passLine.toFixed(1)}${score >= iv.passLine ? " 以上" : " 未満"})` : ""}
              </p>
              <table className="paper-table grid">
                <thead>
                  <tr>
                    <th>評価項目</th>
                    <th>重み</th>
                    <th>平均</th>
                    {evals.map((e) => (
                      <th key={e.userId}>{e.userName}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((cr) => (
                    <tr key={cr.id}>
                      <td>{cr.label}</td>
                      <td className="num">×{cr.weight}</td>
                      <td className="num">{formatScore(avgs[cr.id])}</td>
                      {evals.map((e) => (
                        <td key={e.userId} className="num">
                          {e.ratings[cr.id] ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="total">
                    <td>合計点</td>
                    <td />
                    <td className="num">{formatScore(score)}</td>
                    {evals.map((e) => (
                      <td key={e.userId} className="num">
                        {formatScore(weightedScore(criteria, e.ratings))}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>総合評価</td>
                    <td />
                    <td />
                    {evals.map((e) => (
                      <td key={e.userId}>{e.vote ? VOTE_LABEL[e.vote] : "—"}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
              {evals.map((e) => (
                <div key={e.userId} className="paper-eval">
                  <h3>
                    {e.userName}
                    <span className="paper-sub">
                      {e.vote ? VOTE_LABEL[e.vote] : ""} ・ 提出 {formatDateTime(e.submittedAt)}
                      {(e.revisions ?? 0) > 0 ? ` ・ 提出後に修正 ${e.revisions}回${e.revisedWhileOthersVisible ? "(ほかの評価が見える状態での修正を含む)" : ""}` : ""}
                    </span>
                  </h3>
                  {criteria
                    .filter((cr) => e.criterionComments[cr.id])
                    .map((cr) => (
                      <p key={cr.id}>
                        <b>{cr.label}:</b> {e.criterionComments[cr.id]}
                      </p>
                    ))}
                  {e.comment && <p className="pre">{e.comment}</p>}
                </div>
              ))}
            </>
          )}
        </section>

        <section>
          <h2>判定</h2>
          {iv.decision ? (
            <>
              <p>
                <b>{VOTE_LABEL[iv.decision.result]}</b> ・ {iv.decision.decidedByName} ・ {formatDateTime(iv.decision.decidedAt)}
              </p>
              {iv.decision.reason && <p className="pre">{iv.decision.reason}</p>}
            </>
          ) : (
            <p className="paper-note">まだ判定していません。</p>
          )}
        </section>

        {summary && (
          <section>
            <h2>表情の計測(参考)</h2>
            <p>
              計測の信頼度 {QUALITY_LABEL[summary.quality.level]} ・ 顔の計測率 {formatMetric("faceDetectRate", summary.overall.faceDetectRate)}% ・
              {METRIC_META.expressiveness.label}{" "}
              {summary.quality.level === "low" || summary.overall.expressiveness === null ? "—" : `${Math.round(summary.overall.expressiveness)}/100`}
            </p>
            <table className="paper-table grid">
              <tbody>
                {PRIMARY_METRICS.map((k) => (
                  <tr key={k}>
                    <th>{METRIC_META[k].label}</th>
                    <td className="num">
                      {formatMetric(k, summary.overall[k])}
                      {summary.overall[k] !== null ? METRIC_META[k].unit : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="paper-note">
              表情の出方には、個人差・年齢・緊張などが大きく影響します。数値は能力や性格を測るものではなく、合否は面接官の評価を中心に判断しています。
            </p>
          </section>
        )}

        {withNotes && notes.length > 0 && (
          <section>
            <h2>メモ</h2>
            <ul className="paper-list">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="paper-sub">
                    {n.tMs !== null ? `${iv.recordings.length > 1 && n.recordingId ? `録画${(recIndex.get(n.recordingId) ?? 0) + 1} ` : ""}${formatClock(n.tMs)} ・ ` : ""}
                    {n.userName}
                  </span>
                  <span className="pre">{n.text}</span>
                </li>
              ))}
            </ul>
            {detail.notes.hiddenCount > 0 && <p className="paper-note">ほかに、評価の非公開のため載せていないメモが {detail.notes.hiddenCount} 件あります。</p>}
          </section>
        )}

        {withTranscript &&
          transcripts.map(({ label, t }, i) => (
            <section key={i} className="paper-transcript">
              <h2>文字起こし{label ? `(${label})` : ""}</h2>
              <p className="paper-note">自動の文字起こしです。聞き取りの誤りや、話した人の区別がないことに注意してください。</p>
              {t.segments.map((s, j) => (
                <p key={j}>
                  <span className="paper-sub num">{formatClock(s.startMs)}</span> {s.text}
                </p>
              ))}
            </section>
          ))}
      </article>
    </div>
  );
}
