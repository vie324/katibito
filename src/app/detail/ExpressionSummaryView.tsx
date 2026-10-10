// 表情の計測結果(要約)。数値は「何が測れたか」の記録であって、能力や性格の評価ではない。
// 暫定基準での位置と、これまでの面接(同じ年代を選べる)の中での位置(10件以上たまってから)を並べて見せる。

import { useState } from "react";
import type { ExpressionSummary } from "../../analysis/expression";
import {
  formatMetric,
  METRIC_META,
  PRIMARY_METRICS,
  QUALITY_LABEL,
  REFERENCE_METRICS,
  type MetricKey,
} from "../../analysis/metricsMeta";
import { NORMS_VERSION } from "../../config/scoring";
import { normalizeValue } from "../../engine/scoring";
import type { ExpressionCompare } from "../../shared/types";

/** 比べる相手の分布(指標ごと) */
type CompareTarget = { label: string; n: number; minN: number; values: Record<string, number[]> };

export function ExpressionSummaryView({
  summary,
  compare,
  compact = false,
}: {
  summary: ExpressionSummary;
  /** これまでの面接の分布(読み込み前・読み込めないときは null) */
  compare: ExpressionCompare | null;
  compact?: boolean;
}) {
  // 比べる相手: 同じ年代が十分にあればそちらを先に出す(表情の出方は年齢で大きく違うため)
  const [scope, setScope] = useState<"auto" | "all" | "band">("auto");
  const bandOk = !!compare?.band && compare.band.n >= compare.minN;
  const effective = scope === "auto" ? (bandOk ? "band" : "all") : scope;
  let target: CompareTarget | null = null;
  if (compare) {
    target =
      effective === "band" && compare.band
        ? { label: `同じ年代(${compare.band.label})の`, n: compare.band.n, minN: compare.minN, values: compare.band.values }
        : { label: "これまでの", n: compare.all.n, minN: compare.minN, values: compare.all.values };
  }
  const o = summary.overall;
  const q = summary.quality;
  const lowQuality = q.level === "low";

  return (
    <div className="expr-summary">
      <div className="expr-head">
        <div className="expr-total">
          <span className="expr-total-label">{METRIC_META.expressiveness.label}</span>
          <span className="expr-total-value num">
            {lowQuality || o.expressiveness === null ? "—" : Math.round(o.expressiveness)}
            <span className="unit">/100</span>
          </span>
          {!lowQuality && o.expressiveness !== null && <Band value={o.expressiveness} />}
        </div>
        <div className="expr-quality">
          <span className={`conf-badge ${q.level}`}>計測の信頼度 {QUALITY_LABEL[q.level]}</span>
          <span className="muted small num">
            顔の計測率 {formatMetric("faceDetectRate", o.faceDetectRate)}% ・ 計測できた時間{" "}
            {o.detectedSec < 120 ? `${Math.round(o.detectedSec)}秒` : `${Math.round(o.detectedSec / 60)}分`}
            {q.analysisFps ? ` ・ 毎秒${q.analysisFps}回` : ""}
          </span>
        </div>
      </div>

      {q.notes.length > 0 && (
        <ul className="quality-notes">
          {q.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {lowQuality && (
        <div className="notice notice-warn">
          計測の信頼度が低いため、数値は参考になりません。録画の映像そのもので確認してください。
        </div>
      )}

      {compare && (
        <div className="compare-scope">
          <span className="muted small">比べる相手</span>
          <div className="seg">
            <button type="button" className={effective === "all" ? "active" : ""} onClick={() => setScope("all")}>
              これまでの面接 <span className="num">{compare.all.n}</span>件
            </button>
            {compare.band && (
              <button
                type="button"
                className={effective === "band" ? "active" : ""}
                disabled={!bandOk}
                title={bandOk ? undefined : `同じ年代の面接が ${compare.minN} 件たまると選べます`}
                onClick={() => setScope("band")}
              >
                同じ年代({compare.band.label}) <span className="num">{compare.band.n}</span>件
              </button>
            )}
          </div>
          {!compare.band && <span className="muted small">年齢を入力すると、同じ年代の面接と比べられます</span>}
        </div>
      )}

      <div className={`metric-grid ${lowQuality ? "dimmed" : ""}`}>
        {PRIMARY_METRICS.map((k) => (
          <MetricCard key={k} k={k} value={o[k]} target={target} compact={compact} />
        ))}
      </div>

      {!compact && (
        <details className="ref-metrics">
          <summary>参考値(解釈に注意が必要な指標)</summary>
          <div className="metric-grid">
            {REFERENCE_METRICS.map((k) => (
              <MetricCard key={k} k={k} value={o[k]} target={target} />
            ))}
          </div>
        </details>
      )}

      <p className="caution">
        表情の出方には、個人差・年齢・緊張・体調・文化的な背景などが大きく影響します。
        数値は「その場でどう見えたか」を補助的に記録したもので、能力や性格を測るものではありません。
        合否は面接官の評価を中心に判断してください。
        <span className="muted"> 基準値 {NORMS_VERSION} / 集計 {summary.analysisVersion}(キャリブレーション前の暫定基準)</span>
      </p>
    </div>
  );
}

function MetricCard({ k, value, target, compact }: { k: MetricKey; value: number | null; target: CompareTarget | null; compact?: boolean }) {
  const m = METRIC_META[k];
  const norm = m.norm && value !== null ? normalizeValue(m.norm, value) : null;
  return (
    <div className="metric-card">
      <div className="metric-label">{m.label}</div>
      <div className="metric-value num">
        {formatMetric(k, value)}
        {value !== null && <span className="unit">{m.unit}</span>}
      </div>
      {norm !== null && <Band value={norm} />}
      {target && <DotPlot values={target.values[k] ?? []} n={target.n} minN={target.minN} label={target.label} current={value} />}
      {!compact && <div className="metric-desc">{m.description}</div>}
    </div>
  );
}

/** 暫定基準(NORMS)での位置 0〜100 */
function Band({ value }: { value: number }) {
  return (
    <div className="band" title="暫定基準での位置(左: 少ない 〜 右: 多い)">
      <div className="band-track">
        <div className="band-mid" />
        <div className="band-mark" style={{ left: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

/** これまでの面接の分布の中での位置 */
export function DotPlot({
  values,
  n,
  minN,
  label,
  current,
}: {
  values: number[];
  n: number;
  minN: number;
  label: string;
  current: number | null;
}) {
  if (n < minN) {
    return (
      <div className="dotplot-empty muted small">
        {label}面接との比較は {minN} 件たまると表示します(現在 {n} 件)
      </div>
    );
  }
  if (current === null || values.length === 0) return null;
  const all = [...values, current];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pos = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50);
  const larger = values.filter((v) => v > current).length;
  const pct = Math.round((larger / values.length) * 100);
  return (
    <div className="dotplot">
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden>
        <line x1="0" x2="100" y1="7" y2="7" className="dp-axis" />
        {values.map((v, i) => (
          <circle key={i} cx={pos(v)} cy={7} r={1.6} className="dp-dot" />
        ))}
        <rect x={pos(current) - 0.6} y={1} width={1.2} height={12} className="dp-cur" />
      </svg>
      <div className="muted small">
        {label}
        {values.length}件の中で、大きい方から {Math.max(1, pct)}%
      </div>
    </div>
  );
}
