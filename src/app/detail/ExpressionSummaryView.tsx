// 表情の計測結果(要約)。数値は「何が測れたか」の記録であって、能力や性格の評価ではない。
// 暫定基準での位置と、これまでの面接の中での位置(10件以上たまってから)を並べて見せる。

import type { ExpressionSummary } from "../../analysis/expression";
import {
  formatMetric,
  METRIC_META,
  PRIMARY_METRICS,
  QUALITY_LABEL,
  REFERENCE_METRICS,
  type MetricKey,
} from "../../analysis/metricsMeta";
import { INTERVIEW_ANALYSIS, NORMS_VERSION } from "../../config/scoring";
import { normalizeValue } from "../../engine/scoring";
import type { ExpressionStats } from "../../shared/types";

export function comparisonValues(stats: ExpressionStats | null, interviewId: string, key: MetricKey): number[] {
  if (!stats) return [];
  return stats.items
    .filter((it) => it.interviewId !== interviewId)
    .map((it) => it.values[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function ExpressionSummaryView({
  summary,
  stats,
  interviewId,
  compact = false,
}: {
  summary: ExpressionSummary;
  stats: ExpressionStats | null;
  interviewId: string;
  compact?: boolean;
}) {
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

      <div className={`metric-grid ${lowQuality ? "dimmed" : ""}`}>
        {PRIMARY_METRICS.map((k) => (
          <MetricCard key={k} k={k} value={o[k]} compare={comparisonValues(stats, interviewId, k)} compact={compact} />
        ))}
      </div>

      {!compact && (
        <details className="ref-metrics">
          <summary>参考値(解釈に注意が必要な指標)</summary>
          <div className="metric-grid">
            {REFERENCE_METRICS.map((k) => (
              <MetricCard key={k} k={k} value={o[k]} compare={comparisonValues(stats, interviewId, k)} />
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

function MetricCard({ k, value, compare, compact }: { k: MetricKey; value: number | null; compare: number[]; compact?: boolean }) {
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
      <DotPlot values={compare} current={value} />
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
export function DotPlot({ values, current }: { values: number[]; current: number | null }) {
  const n = values.length;
  if (n < INTERVIEW_ANALYSIS.COMPARE_MIN_N) {
    return (
      <div className="dotplot-empty muted small">
        過去の面接との比較は {INTERVIEW_ANALYSIS.COMPARE_MIN_N} 件たまると表示します(現在 {n} 件)
      </div>
    );
  }
  if (current === null) return null;
  const all = [...values, current];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pos = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50);
  const larger = values.filter((v) => v > current).length;
  const pct = Math.round((larger / n) * 100);
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
        過去{n}件の中で、大きい方から {Math.max(1, pct)}%
      </div>
    </div>
  );
}
