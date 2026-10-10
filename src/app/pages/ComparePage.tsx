// 候補者の比較。合計点・評価項目ごとの平均・票・判定・表情の計測を並べ、並べ替え・絞り込みする。
// 同じ画面のタブで、面接官ごとの評価の傾向(ほかの面接官より高め・低めか)も見る。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { COMPARABLE_METRICS, formatMetric, METRIC_META, type MetricKey } from "../../analysis/metricsMeta";
import { formatScore } from "../../shared/score";
import { VOTE_LABEL } from "../../shared/status";
import type { CompareRow, RaterStats, Vote } from "../../shared/types";
import { api, errorMessage } from "../api";
import { saveFile } from "../download";
import { formatDateTime, jstDateKey } from "../format";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import { Empty, Loading, Notice, StatusChip, useToast, VoteChip } from "../ui";

type Tab = "candidates" | "raters";

export default function ComparePage() {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>("candidates");
  return (
    <div className="page wide">
      <div className="page-head">
        <h2>比較</h2>
      </div>
      <div className="tabs big-tabs">
        <button className={`tab ${tab === "candidates" ? "active" : ""}`} onClick={() => setTab("candidates")}>
          候補者
        </button>
        <button className={`tab ${tab === "raters" ? "active" : ""}`} onClick={() => setTab("raters")}>
          {user?.role === "admin" ? "面接官の評価の傾向" : "あなたの評価の傾向"}
        </button>
      </div>
      {tab === "candidates" ? <CandidatesTab /> : <RatersTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 候補者
// ---------------------------------------------------------------------------

type SortKey = "date" | "name" | "age" | "score" | "pass" | "expr" | `crit:${string}`;
type DecisionFilter = "all" | "open" | Vote;

const ALL = "__all__";
const NONE = "__none__";

function templateKey(r: CompareRow): string {
  return r.templateId ?? `name:${r.templateName}`;
}

function rowDate(r: CompareRow): string {
  return r.scheduledAt ?? r.createdAt;
}

function CandidatesTab() {
  const { user } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [round, setRound] = useState(ALL);
  const [template, setTemplate] = useState(ALL);
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [q, setQ] = useState("");
  const [latestOnly, setLatestOnly] = useState(false);
  const [metric, setMetric] = useState<MetricKey>("expressiveness");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api
      .compare()
      .then((r) => setRows(r.rows))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const rounds = useMemo(() => [...new Set((rows ?? []).map((r) => r.round))].sort((a, b) => a.localeCompare(b, "ja")), [rows]);
  const templates = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) if (!m.has(templateKey(r))) m.set(templateKey(r), r.templateName || "(名前なし)");
    return [...m.entries()];
  }, [rows]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list = (rows ?? []).filter((r) => {
      const d = jstDateKey(rowDate(r));
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (round !== ALL && r.round !== (round === NONE ? "" : round)) return false;
      if (template !== ALL && templateKey(r) !== template) return false;
      if (decision === "open" && r.decision) return false;
      if (decision !== "all" && decision !== "open" && r.decision !== decision) return false;
      if (query && !r.candidate.displayName.toLowerCase().includes(query) && !r.candidate.kana.toLowerCase().includes(query)) return false;
      return true;
    });
    if (latestOnly) {
      // 同じ候補者(一次・二次…)は、いちばん新しい面接だけ
      const latest = new Map<string, CompareRow>();
      for (const r of list) {
        const cur = latest.get(r.applicantId);
        if (!cur || rowDate(r) > rowDate(cur)) latest.set(r.applicantId, r);
      }
      list = list.filter((r) => latest.get(r.applicantId) === r);
    }
    return list;
  }, [rows, from, to, round, template, decision, q, latestOnly]);

  // 評価シートを1つに絞ったときだけ、評価項目ごとの列を出す(シートごとに項目が違うため)
  const critColumns = useMemo(() => {
    if (template === ALL) return [];
    const cols: { label: string; weight: number }[] = [];
    for (const r of filtered) {
      for (const c of r.criteria ?? []) if (!cols.some((x) => x.label === c.label)) cols.push({ label: c.label, weight: c.weight });
    }
    return cols;
  }, [filtered, template]);

  const sorted = useMemo(() => {
    const value = (r: CompareRow): number | string | null => {
      switch (sort.key) {
        case "date":
          return rowDate(r);
        case "name":
          return r.candidate.kana || r.candidate.displayName;
        case "age":
          return r.candidate.age;
        case "score":
          return r.score;
        case "pass":
          return r.votes ? r.votes.pass - r.votes.fail : null;
        case "expr":
          return r.expression?.[metric] ?? null;
        default: {
          const label = sort.key.slice(5);
          return r.criteria?.find((c) => c.label === label)?.avg ?? null;
        }
      }
    };
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // 値のないもの(非公開・未入力)は、並べ替えの向きにかかわらず最後
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb, "ja") : (va as number) - (vb as number);
      return c * sort.dir;
    });
  }, [filtered, sort, metric]);

  const summary = useMemo(() => {
    const scores = filtered.map((r) => r.score).filter((x): x is number => x !== null);
    const d = { pass: 0, hold: 0, fail: 0, open: 0 };
    for (const r of filtered) {
      if (r.decision) d[r.decision]++;
      else d.open++;
    }
    return {
      scoreAvg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      scoreN: scores.length,
      hidden: filtered.filter((r) => !r.visible).length,
      ...d,
    };
  }, [filtered]);

  const header = (key: SortKey, label: ReactNode, title?: string) => (
    <th
      className={`sortable ${sort.key === key ? "sorted" : ""}`}
      title={title}
      onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }))}
    >
      {label}
      {sort.key === key && <span className="sort-mark">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const data = await api.exportCsv(sorted.map((r) => r.id));
      saveFile(data, `面接比較_${jstDateKey(new Date())}.csv`, "text/csv;charset=utf-8");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setExporting(false);
    }
  };

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!rows) return <Loading />;
  if (rows.length === 0) return <Empty>まだ面接がありません。</Empty>;

  const mm = METRIC_META[metric];
  return (
    <>
      <div className="compare-filters">
        <label>
          <span className="muted small">期間</span>
          <span className="range">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="期間の始め" />
            <span className="muted">〜</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="期間の終わり" />
          </span>
        </label>
        <label>
          <span className="muted small">面接の段階</span>
          <select value={round} onChange={(e) => setRound(e.target.value)}>
            <option value={ALL}>すべて</option>
            {rounds.map((r) => (
              <option key={r || NONE} value={r || NONE}>
                {r || "(段階なし)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted small">評価シート</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value={ALL}>すべて</option>
            {templates.map(([k, name]) => (
              <option key={k} value={k}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted small">判定</span>
          <select value={decision} onChange={(e) => setDecision(e.target.value as DecisionFilter)}>
            <option value="all">すべて</option>
            <option value="open">未判定</option>
            <option value="pass">合格</option>
            <option value="hold">保留</option>
            <option value="fail">不合格</option>
          </select>
        </label>
        <label>
          <span className="muted small">表情の指標</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
            {COMPARABLE_METRICS.map((k) => (
              <option key={k} value={k}>
                {METRIC_META[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span className="muted small">候補者</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前・ふりがなで探す" />
        </label>
        <label className="check small">
          <input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} />
          <span>同じ候補者は最新の面接だけ</span>
        </label>
      </div>

      <div className="compare-summary">
        <span>
          <span className="num">{filtered.length}</span> 件
        </span>
        <span>
          合計点の平均 <span className="num">{formatScore(summary.scoreAvg)}</span>
          {summary.scoreN < filtered.length && <span className="muted small">(点数が見える {summary.scoreN} 件)</span>}
        </span>
        <span>
          合格 <span className="num">{summary.pass}</span> ・ 保留 <span className="num">{summary.hold}</span> ・ 不合格{" "}
          <span className="num">{summary.fail}</span> ・ 未判定 <span className="num">{summary.open}</span>
        </span>
        <span className="spacer" />
        {user?.role === "admin" && (
          <button className="quiet" disabled={exporting || sorted.length === 0} onClick={() => void exportCsv()}>
            {exporting ? "作成中…" : `表示中の ${sorted.length} 件を CSV で保存`}
          </button>
        )}
      </div>
      {summary.hidden > 0 && (
        <div className="muted small compare-hidden-note">
          「非公開」の面接は、自分の評価を提出すると点数と票が表示されます(評価の非公開の設定)。
        </div>
      )}

      {sorted.length === 0 ? (
        <Empty>条件に合う面接はありません。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="list compare-table">
            <thead>
              <tr>
                {header("name", "候補者")}
                {header("date", "面接")}
                {template === ALL && <th>評価シート</th>}
                <th>評価</th>
                {header("pass", "票", "合格票 − 不合格票 の順")}
                {header("score", "合計点")}
                {critColumns.map((c) =>
                  header(
                    `crit:${c.label}`,
                    <>
                      {c.label}
                      {c.weight !== 1 && <span className="muted"> ×{c.weight}</span>}
                    </>,
                  ),
                )}
                {header(
                  "expr",
                  <>
                    {mm.label}
                    {mm.unit && <span className="muted">({mm.unit})</span>}
                  </>,
                  "表情の計測(参考)。信頼度が低い計測と、計測に同意がない面接は空欄",
                )}
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/interviews/${r.id}`)}>
                  <td>
                    <Link to={`/interviews/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      {r.candidate.displayName}
                    </Link>
                    <div className="muted small">
                      {r.candidate.kana}
                      {r.candidate.kana && r.candidate.age !== null ? " ・ " : ""}
                      {r.candidate.age !== null ? `${r.candidate.age}歳` : ""}
                    </div>
                  </td>
                  <td className="small nowrap">
                    <span className="num">{formatDateTime(rowDate(r))}</span>
                    {r.round && <div className="muted">{r.round}</div>}
                  </td>
                  {template === ALL && <td className="small">{r.templateName}</td>}
                  <td className="small nowrap num">
                    {r.submittedCount}/{r.expectedCount || "—"}
                  </td>
                  <td className="small nowrap">
                    {r.votes ? (
                      <div className="vote-tally">
                        {r.votes.pass > 0 && <span className="vote vote-pass">合格 {r.votes.pass}</span>}
                        {r.votes.hold > 0 && <span className="vote vote-hold">保留 {r.votes.hold}</span>}
                        {r.votes.fail > 0 && <span className="vote vote-fail">不合格 {r.votes.fail}</span>}
                        {r.votes.pass + r.votes.hold + r.votes.fail === 0 && <span className="muted">—</span>}
                      </div>
                    ) : (
                      <span className="muted" title="自分の評価を提出すると表示されます">
                        非公開
                      </span>
                    )}
                  </td>
                  <td className="nowrap">
                    {r.visible ? <ScoreBar score={r.score} passLine={r.passLine} /> : <span className="muted small">非公開</span>}
                  </td>
                  {critColumns.map((c) => {
                    const v = r.criteria?.find((x) => x.label === c.label)?.avg ?? null;
                    return (
                      <td key={c.label} className="num small center">
                        {r.visible ? formatScore(v) : ""}
                      </td>
                    );
                  })}
                  <td className="num small center">{r.expression ? formatMetric(metric, r.expression[metric]) : <span className="muted">—</span>}</td>
                  <td className="nowrap">{r.decision ? <VoteChip vote={r.decision} /> : <StatusChip status={r.status} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="caution">
        合計点は評価シートの重みつき平均(1〜5)です。評価シートが違う面接どうしは、項目や重みが違うため単純には比べられません。
        表情の計測は「その場でどう見えたか」の参考値で、年齢・緊張・体調などの影響を大きく受けます。合否は面接官の評価を中心に判断してください。
      </p>
    </>
  );
}

/** 合計点(1〜5)の横棒。合格の目安があれば目盛りを出す */
function ScoreBar({ score, passLine }: { score: number | null; passLine: number | null }) {
  if (score === null) return <span className="muted small">—</span>;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - 1) / 4) * 100))}%`;
  const ok = passLine !== null && score >= passLine;
  return (
    <span className="score-bar" title={passLine !== null ? `合格の目安 ${passLine}` : undefined}>
      <span className="num score-bar-value">{formatScore(score)}</span>
      <span className="score-bar-track">
        <span className={`score-bar-fill ${ok ? "ok" : ""}`} style={{ width: pos(score) }} />
        {passLine !== null && <span className="score-bar-line" style={{ left: pos(passLine) }} />}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 面接官の評価の傾向
// ---------------------------------------------------------------------------

/** 差の表示をこれ未満の件数では「参考程度」とする */
const FEW = 5;

function hours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return "1時間以内";
  if (h < 48) return `${Math.round(h)}時間`;
  return `${Math.round(h / 24)}日`;
}

function signed(x: number | null, digits = 2): string {
  if (x === null) return "—";
  const v = x.toFixed(digits);
  return x > 0 ? `+${v}` : v;
}

function RatersTab() {
  const { user } = useSession();
  const [raters, setRaters] = useState<RaterStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .raterStats()
      .then((r) => setRaters(r.raters))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!raters) return <Loading />;

  return (
    <>
      <p className="muted small rater-intro">
        同じ面接を評価した、ほかの面接官の合計点の平均との差です。プラスなら高め、マイナスなら低めにつける傾向があります。
        差の大きい項目は、評価の基準をそろえる話し合いの材料にしてください。面接官を評価するための数字ではありません。
      </p>
      {raters.length === 0 ? (
        <Empty>まだ提出された評価がありません。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="list rater-table">
            <thead>
              <tr>
                <th>面接官</th>
                <th>提出</th>
                <th>平均点</th>
                <th title="同じ面接のほかの面接官の平均との差の平均">ほかの面接官との差</th>
                <th title="差の大きさ(絶対値)の平均">差の大きさ</th>
                <th>票の内訳</th>
                <th title="判定が出た面接で、自分の票が判定と同じだった割合">判定との一致</th>
                <th title="面接(録画の開始、なければ予定日時)から提出までの時間の中央値">提出まで</th>
                <th>差の大きい項目</th>
              </tr>
            </thead>
            <tbody>
              {raters.map((r) => {
                const crit = r.criteria
                  .filter((c) => c.n >= 3)
                  .sort((a, b) => Math.abs(b.meanDiff) - Math.abs(a.meanDiff))
                  .slice(0, 3);
                const agree = r.decisionAgreement;
                return (
                  <tr key={r.userId} className={r.userId === user?.id ? "me" : ""}>
                    <td className="nowrap">{r.name}</td>
                    <td className="num">{r.submitted}</td>
                    <td className="num">{formatScore(r.meanScore)}</td>
                    <td>
                      <DiffBar diff={r.meanDiff} />
                      <div className="muted small">
                        {r.panelCount} 件で比較{r.panelCount > 0 && r.panelCount < FEW ? "(件数が少ないため参考程度)" : ""}
                      </div>
                    </td>
                    <td className="num">{r.meanAbsDiff === null ? "—" : r.meanAbsDiff.toFixed(2)}</td>
                    <td className="small nowrap">
                      {(["pass", "hold", "fail"] as Vote[]).map((v) => (
                        <span key={v} className={`vote vote-${v}`}>
                          {VOTE_LABEL[v]} {r.votes[v]}
                        </span>
                      ))}
                    </td>
                    <td className="num nowrap">
                      {agree.n > 0 ? (
                        <>
                          {Math.round((agree.agree / agree.n) * 100)}%<span className="muted small">({agree.agree}/{agree.n})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="nowrap small">{hours(r.medianSubmitHours)}</td>
                    <td className="small">
                      {crit.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        crit.map((c) => (
                          <div key={c.label}>
                            {c.label} <span className={`num ${c.meanDiff > 0 ? "ok-text" : "warn-text"}`}>{signed(c.meanDiff)}</span>
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** 0 を中心にした差の棒(±1.5 点の範囲) */
function DiffBar({ diff }: { diff: number | null }) {
  if (diff === null) return <span className="muted small">—</span>;
  const w = Math.min(50, (Math.abs(diff) / 1.5) * 50);
  return (
    <span className="diff-bar" title={signed(diff)}>
      <span className="diff-track">
        <span className="diff-mid" />
        <span className={`diff-fill ${diff >= 0 ? "plus" : "minus"}`} style={diff >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
      </span>
      <span className="num">{signed(diff)}</span>
    </span>
  );
}
