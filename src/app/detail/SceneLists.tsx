// 注目シーン・質問ごとの集計・メモ。いずれもクリックで動画のその時刻へ移動する。

import { useState } from "react";
import type { ExpressionSummary, Highlight, SegmentSummary } from "../../analysis/expression";
import { formatMetric } from "../../analysis/metricsMeta";
import type { Note } from "../../shared/types";
import { formatClock, formatDateTime } from "../format";
import { internalPath } from "../links";
import { Link } from "../router";
import { useSession } from "../session";

const KIND_ICON: Record<Highlight["kind"], string> = { smile: "☺", expression: "◆", gap: "!" };

/** メモの本文。このアプリの中へのリンク(場面へのリンクなど)だけ押せるようにする(外部のサイトへは開かない) */
export function NoteText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) => {
        const to = /^https?:\/\//.test(p) ? internalPath(p, window.location.origin) : null;
        if (to) {
          const t = new URLSearchParams(to.split("?")[1] ?? "").get("t");
          return (
            <Link key={i} to={to}>
              {t ? `場面へのリンク(${formatClock(Number(t) * 1000)})` : "リンク"}
            </Link>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export function HighlightList({ highlights, onSeek }: { highlights: Highlight[]; onSeek: (ms: number) => void }) {
  if (highlights.length === 0) return <div className="muted small pad">目立った場面は見つかりませんでした。</div>;
  return (
    <ul className="scene-list">
      {highlights.map((h, i) => (
        <li key={i}>
          <button className={`scene scene-${h.kind}`} onClick={() => onSeek(Math.max(0, h.tMs - 2000))}>
            <span className="scene-icon" aria-hidden>
              {KIND_ICON[h.kind]}
            </span>
            <span className="num scene-time">{formatClock(h.tMs)}</span>
            <span className="scene-label">{h.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const SEG_COLS: { key: keyof SegmentSummary["metrics"]; label: string }[] = [
  { key: "smileRate", label: "笑顔の頻度(%)" },
  { key: "smilePerMin", label: "笑顔(回/分)" },
  { key: "browActivity", label: "眉の動き(%)" },
  { key: "nodRate", label: "うなずき(回/分)" },
  { key: "expressiveness", label: "表情の豊かさ" },
  { key: "faceDetectRate", label: "顔の計測率(%)" },
];

export function SegmentTable({ summary, onSeek }: { summary: ExpressionSummary; onSeek: (ms: number) => void }) {
  const segs = summary.segments;
  if (segs.length === 0) {
    return (
      <div className="muted small pad">
        録画中に質問のボタンが押されていないため、質問ごとの集計はありません(録画のあとから区切りを追加できます)。
      </div>
    );
  }
  const max = (k: keyof SegmentSummary["metrics"]) =>
    Math.max(1e-9, ...segs.map((s) => (typeof s.metrics[k] === "number" ? (s.metrics[k] as number) : 0)));
  return (
    <div className="table-wrap">
      <table className="seg-table">
        <thead>
          <tr>
            <th>区切り</th>
            <th>時間</th>
            {SEG_COLS.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {segs.map((s, i) => (
            <tr key={i} className="clickable" onClick={() => onSeek(s.startMs)}>
              <td className={s.kind === "preamble" ? "muted" : ""}>{s.label}</td>
              <td className="num nowrap">
                {formatClock(s.startMs)}〜{formatClock(s.endMs)}
              </td>
              {SEG_COLS.map((c) => {
                const v = s.metrics[c.key] as number | null;
                const lowData = s.metrics.detectedSec < 10 && c.key !== "faceDetectRate";
                return (
                  <td key={c.key} className="num cell-bar">
                    {lowData ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <span className="bar" style={{ width: `${v === null ? 0 : Math.round((v / max(c.key)) * 100)}%` }} />
                        <span className="v">{c.key === "expressiveness" ? (v === null ? "—" : Math.round(v)) : formatMetric(c.key, v)}</span>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotesList({
  notes,
  hiddenCount,
  recordingId,
  canStamp,
  getTimeMs,
  onSeek,
  onAdd,
  onDelete,
}: {
  notes: Note[];
  hiddenCount: number;
  recordingId: string | null;
  canStamp: boolean;
  getTimeMs: () => number;
  onSeek: (ms: number) => void;
  onAdd: (text: string, tMs: number | null) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { user } = useSession();
  const [text, setText] = useState("");
  const [stamp, setStamp] = useState(true);
  const [busy, setBusy] = useState(false);
  const shown = notes
    .filter((n) => n.recordingId === null || n.recordingId === recordingId)
    .slice()
    .sort((a, b) => (a.tMs ?? -1) - (b.tMs ?? -1) || a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="notes">
      {shown.length === 0 && <div className="muted small">まだメモはありません。</div>}
      <ul className="note-list">
        {shown.map((n) => (
          <li key={n.id}>
            {n.tMs !== null ? (
              <button className="note-time num" onClick={() => onSeek(Math.max(0, n.tMs! - 1000))}>
                {formatClock(n.tMs)}
              </button>
            ) : (
              <span className="note-time muted">全体</span>
            )}
            <div className="note-body">
              <div className="note-text">
                <NoteText text={n.text} />
              </div>
              {n.kind === "room" && <div className="muted small">面接室へのメッセージ</div>}
              <div className="muted small">
                {n.userName} ・ {formatDateTime(n.createdAt)}
                {(n.userId === user?.id || user?.role === "admin") && (
                  <button className="quiet tiny" onClick={() => void onDelete(n.id)}>
                    削除
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && <div className="muted small">ほかの評価者のメモが {hiddenCount} 件あります(自分の評価を提出すると表示されます)。</div>}
      <form
        className="note-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          const ok = await onAdd(text.trim(), canStamp && stamp ? Math.round(getTimeMs()) : null);
          setBusy(false);
          if (ok) setText("");
        }}
      >
        <textarea
          rows={2}
          placeholder="気づいたことを書く(例: ここの受け答えが具体的)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
        />
        <div className="row-actions">
          {canStamp && (
            <label className="check small">
              <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} />
              <span>いま再生している時刻に紐づける</span>
            </label>
          )}
          <span className="spacer" />
          <button className="primary" disabled={busy || !text.trim()}>
            メモを追加
          </button>
        </div>
      </form>
    </div>
  );
}
