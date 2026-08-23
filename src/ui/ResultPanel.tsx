// 結果画面(§7)。上から: 4象限プロット / 判定 / 根拠テーブル / 接し方ガイド / タイムライン。
// 確信度「低」のときは象限名を出さない(§6.5)。注記「キャリブレーション前」は常時表示。

import { useEffect, useState } from "react";
import { FLAGS } from "../config/flags";
import {
  LOW_CONFIDENCE_MESSAGE,
  PROVISIONAL_NOTE,
} from "../config/guides";
import { QUADRANTS } from "../config/scoring";
import { buildTemplateGuide, generateGuide, type GuideResult } from "../engine/guide";
import { CONFIDENCE_LABEL_JA } from "../engine/scoring";
import { downloadJson } from "../engine/sessionStore";
import { EvidenceTable } from "./EvidenceTable";
import { formatAxis } from "./format";
import { QuadrantTrace } from "./QuadrantTrace";
import { Timeline } from "./Timeline";
import type { ResultData } from "./types";

type ResultPanelProps = {
  data: ResultData;
  onRestart: () => void;
};

export function ResultPanel({ data, onRestart }: ResultPanelProps) {
  const { session, score, replay, videoUrl } = data;
  const confLabel = score.confidence.label;
  const quadrant = score.quadrant;
  const showQuadrant = confLabel !== "low" && quadrant !== null;

  const [guide, setGuide] = useState<GuideResult | null>(null);

  useEffect(() => {
    if (!showQuadrant || quadrant === null) {
      setGuide(null);
      return;
    }
    // テンプレートを即時表示し、Claude API が使える構成なら差し替える(§7)
    setGuide({ text: buildTemplateGuide(quadrant, score), source: "template" });
    let cancelled = false;
    void generateGuide(quadrant, score).then((g) => {
      if (!cancelled) setGuide(g);
    });
    return () => {
      cancelled = true;
    };
  }, [showQuadrant, quadrant, score]);

  const id8 = session.sessionId.slice(0, 8);

  return (
    <>
      <div className="result-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div className="panel verdict">
            <div className="panel-title" style={{ margin: "calc(-1 * var(--space-4))", marginBottom: "var(--space-3)" }}>
              判定 — キャリブレーション前の暫定判定
            </div>
            {showQuadrant ? (
              <>
                <div className="quadrant-name">{QUADRANTS[quadrant].name}</div>
                <div className="axes-line num">
                  <span className="a">主張性 {formatAxis(session.aggregate.assertiveness)}</span>
                  <span className="e">感情表出性 {formatAxis(session.aggregate.expressiveness)}</span>
                </div>
              </>
            ) : (
              <>
                <div className="lowconf">{LOW_CONFIDENCE_MESSAGE}</div>
                <div className="axes-line num">
                  <span className="a">主張性 {formatAxis(session.aggregate.assertiveness)}</span>
                  <span className="e">感情表出性 {formatAxis(session.aggregate.expressiveness)}</span>
                </div>
              </>
            )}
            <div className="conf-line">
              <span className={`conf-badge ${confLabel}`}>確信度 {CONFIDENCE_LABEL_JA[confLabel]}</span>
              {!session.environment.gatePassed && (
                <span className="badge">環境チェック未達のまま計測</span>
              )}
            </div>
            <div className="note">
              {PROVISIONAL_NOTE}
              <br />
              基準値: <span className="num">{session.normsVersion}</span>
              {session.environment.speechRecognitionUsed && (
                <>
                  <br />
                  文字起こしに Chrome の音声認識を使用(音声は Google に送信されます)
                </>
              )}
            </div>
          </div>

          {showQuadrant && guide && (
            <div className="panel guide">
              <div className="panel-title" style={{ margin: "calc(-1 * var(--space-4))", marginBottom: "var(--space-3)" }}>
                接し方ガイド
              </div>
              {guide.text.split("\n").map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              <div className="source num">
                {guide.source === "api" ? "生成: Claude API" : "生成: テンプレート"}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">4象限プロット — 最終位置とセッション軌跡</div>
          <QuadrantTrace
            mode="static"
            trail={{ a: replay.live.a, e: replay.live.e }}
            finalA={session.aggregate.assertiveness}
            finalE={session.aggregate.expressiveness}
          />
        </div>
      </div>

      <EvidenceTable score={score} features={session.aggregate.features} />

      <Timeline replay={replay} videoUrl={videoUrl} />

      <div className="export-row">
        <button
          className="primary"
          onClick={() => downloadJson(session, `signal-session-${id8}.json`)}
        >
          結果をJSONで保存
        </button>
        {FLAGS.ENABLE_REPLAY_EXPORT && (
          <button
            className="quiet"
            onClick={() => downloadJson(replay, `signal-replay-${id8}.json`)}
          >
            リプレイ用データを保存(開発用)
          </button>
        )}
        <span className="hint">映像・音声はJSONに含まれません。groundTruth 欄は他者評価の追記用です。</span>
        <span style={{ flex: 1 }} />
        <button onClick={onRestart}>最初に戻る</button>
      </div>
    </>
  );
}
