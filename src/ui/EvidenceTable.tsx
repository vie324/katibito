// 根拠テーブル(§7)。全特徴量の生値・正規化値・寄与度を畳まずに全部出す。
// ここが最重要 — 人間が検算できる状態にする。

import {
  FEATURE_META,
  type Axis,
  type FeatureKey,
  type ReferenceFeatureKey,
} from "../config/scoring";
import type { Contribution, ScoreResult } from "../engine/scoring";
import { featureUnit, formatFeature } from "./format";

type EvidenceTableProps = {
  score: ScoreResult;
  features: Record<string, number | null>;
};

const AXIS_LABEL: Record<Axis, string> = {
  assertiveness: "主張性",
  expressiveness: "感情表出性",
};

const AXIS_COLOR: Record<Axis, string> = {
  assertiveness: "var(--signal-a)",
  expressiveness: "var(--signal-e)",
};

const REFERENCE_KEYS = (Object.keys(FEATURE_META) as FeatureKey[]).filter(
  (k) => FEATURE_META[k].axis === "reference",
) as ReferenceFeatureKey[];

const EXCLUDED_LABEL: Record<string, string> = {
  missing: "計測なし",
  "lexicon-unreliable": "辞書ヒット不足",
};

function ContributionRow({ c, axis }: { c: Contribution; axis: Axis }) {
  const meta = FEATURE_META[c.key];
  const excluded = c.excludedReason !== null;
  return (
    <tr className={excluded ? "dimmed" : ""}>
      <td>{meta.label}</td>
      <td className="raw num">
        {formatFeature(c.key, c.raw)}
        <span className="unit">{featureUnit(c.key)}</span>
      </td>
      <td className="normbar">
        <div className="track">
          {c.norm !== null && (
            <div
              className="fill"
              style={{
                width: `${c.norm}%`,
                background: AXIS_COLOR[axis],
                opacity: excluded ? 0.25 : 0.7,
              }}
            />
          )}
          <div className="center" />
        </div>
      </td>
      <td className="num">{c.norm === null ? "—" : Math.round(c.norm)}</td>
      <td className="num">{(c.weight * 100).toFixed(0)}%</td>
      <td className="num">
        {excluded || c.points === null ? (
          <span className="excluded-note">
            {c.excludedReason ? EXCLUDED_LABEL[c.excludedReason] : "—"}
          </span>
        ) : (
          `+${c.points.toFixed(1)}`
        )}
      </td>
    </tr>
  );
}

export function EvidenceTable({ score, features }: EvidenceTableProps) {
  const sections: { axis: Axis; contributions: Contribution[]; total: number | null }[] = [
    {
      axis: "assertiveness",
      contributions: score.assertiveness.contributions,
      total: score.assertiveness.score,
    },
    {
      axis: "expressiveness",
      contributions: score.expressiveness.contributions,
      total: score.expressiveness.score,
    },
  ];

  return (
    <div className="panel evidence">
      <div className="panel-title">根拠テーブル — 全特徴量の生値・正規化値・寄与</div>
      <table>
        <thead>
          <tr>
            <th>指標</th>
            <th style={{ textAlign: "right" }}>生値</th>
            <th colSpan={2}>正規化 (0–100)</th>
            <th>重み</th>
            <th>寄与</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <SectionRows key={sec.axis} {...sec} />
          ))}
          <tr className="axis-head axis-ref">
            <td colSpan={6}>参考値(採点対象外)</td>
          </tr>
          {REFERENCE_KEYS.map((key) => (
            <tr key={key} className="dimmed">
              <td>{FEATURE_META[key].label}</td>
              <td className="raw num">
                {formatFeature(key, features[key] ?? null)}
                <span className="unit">{featureUnit(key)}</span>
              </td>
              <td className="normbar">
                <div className="track">
                  <div className="center" />
                </div>
              </td>
              <td className="num">—</td>
              <td className="num">—</td>
              <td className="num">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({
  axis,
  contributions,
  total,
}: {
  axis: Axis;
  contributions: Contribution[];
  total: number | null;
}) {
  return (
    <>
      <tr className={`axis-head axis-${axis === "assertiveness" ? "a" : "e"}`}>
        <td colSpan={5}>{AXIS_LABEL[axis]}</td>
        <td className="num">{total === null ? "—" : `= ${total.toFixed(1)}`}</td>
      </tr>
      {contributions.map((c) => (
        <ContributionRow key={c.key} c={c} axis={axis} />
      ))}
    </>
  );
}
