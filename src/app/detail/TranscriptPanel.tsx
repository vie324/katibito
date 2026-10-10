// 文字起こし(サーバー内の whisper.cpp で作成)。録画の時刻と結びつけて表示し、押すとその場面へ移動する。
// 質問の区切りごとに見出しをつけ、再生中の箇所を強調する。キーワードで絞り込める。

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Marker, RecordingMeta, Transcript, TranscriptSegment } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatClock } from "../format";
import { useSession } from "../session";
import { Loading, Notice, useToast } from "../ui";

function highlight(text: string, q: string) {
  if (!q) return text;
  const parts: (string | JSX.Element)[] = [];
  let rest = text;
  let k = 0;
  for (;;) {
    const i = rest.indexOf(q);
    if (i < 0) break;
    if (i > 0) parts.push(rest.slice(0, i));
    parts.push(<mark key={k++}>{q}</mark>);
    rest = rest.slice(i + q.length);
  }
  parts.push(rest);
  return parts;
}

/** 区間がどの質問の中か(その時刻以前で最後の質問の区切り) */
function questionAt(markers: Marker[], t: number): Marker | null {
  let cur: Marker | null = null;
  for (const m of markers) {
    if (m.kind !== "question") continue;
    if (m.tMs <= t + 500) cur = m;
    else break;
  }
  return cur;
}

export function TranscriptPanel({
  iid,
  rec,
  onSeek,
  getTimeMs,
  onChanged,
}: {
  iid: string;
  rec: RecordingMeta;
  onSeek: (ms: number) => void;
  getTimeMs: () => number;
  onChanged: (rec: RecordingMeta) => void;
}) {
  const { user, info } = useSession();
  const toast = useToast();
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    setTranscript(null);
    setError(null);
    if (rec.transcript !== "ready") return;
    let alive = true;
    api
      .transcript(iid, rec.id)
      .then((r) => alive && setTranscript(r.transcript))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [iid, rec.id, rec.transcript]);

  // 再生位置に合わせて強調する
  useEffect(() => {
    if (!transcript) return;
    const t = setInterval(() => setNow(getTimeMs()), 500);
    return () => clearInterval(t);
  }, [transcript, getTimeMs]);

  const markers = useMemo(() => rec.markers.filter((m) => m.kind === "question").slice().sort((a, b) => a.tMs - b.tMs), [rec.markers]);
  const query = q.trim();
  const shown: TranscriptSegment[] = useMemo(
    () => (transcript?.segments ?? []).filter((s) => !query || s.text.includes(query)),
    [transcript, query],
  );
  const activeIndex = shown.findIndex((s) => now >= s.startMs && now < Math.max(s.endMs, s.startMs + 1000));

  useEffect(() => {
    if (!follow || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-seg="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, follow]);

  const request = async () => {
    try {
      const r = await api.requestTranscript(iid, rec.id);
      onChanged(r.recording);
      toast("文字起こしを始めました。録画の長さによっては時間がかかります");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (rec.transcript === "queued" || rec.transcript === "running") {
    return (
      <div className="pad">
        <Notice kind="info">
          {rec.transcript === "queued" ? "文字起こしの順番を待っています。" : "文字起こしをしています。"}
          サーバーの中で処理しているため、録画の長さの数分の1〜同じくらいの時間がかかります(外部のサービスには送りません)。
        </Notice>
      </div>
    );
  }
  if (rec.transcript === "failed") {
    return (
      <div className="pad">
        <Notice kind="error">
          文字起こしに失敗しました: {rec.transcriptError ?? "不明なエラー"}
          {isAdmin && (
            <button className="small-btn" onClick={() => void request()}>
              やり直す
            </button>
          )}
        </Notice>
      </div>
    );
  }
  if (rec.transcript === "none") {
    return (
      <div className="pad muted small">
        {info?.features.transcription ? (
          <>
            この録画の文字起こしはありません。
            {isAdmin && (
              <button className="small-btn" onClick={() => void request()}>
                文字起こしする
              </button>
            )}
          </>
        ) : (
          "サーバーで文字起こしを使えるようにすると(運用ガイド参照)、録画の音声が自動で文字になります。"
        )}
      </div>
    );
  }
  if (error) return <Notice kind="error">文字起こしを読み込めません: {error}</Notice>;
  if (!transcript) return <Loading />;

  let lastQ: string | null = null;
  return (
    <div className="transcript">
      <div className="transcript-tools">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ことばで探す" aria-label="文字起こしを検索" />
        <label className="check small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span>再生に合わせる</span>
        </label>
      </div>
      <div className="muted small transcript-note">
        自動の文字起こしです。聞き取りの誤りや、話した人の区別がないことに注意してください。押すとその場面へ移動します。
      </div>
      <div className="transcript-list" ref={listRef}>
        {shown.length === 0 && <div className="muted small pad">{query ? "見つかりませんでした。" : "話し声が見つかりませんでした。"}</div>}
        {shown.map((s, i) => {
          const qm = questionAt(markers, s.startMs);
          const head = qm && qm.label !== lastQ ? qm.label : null;
          if (qm) lastQ = qm.label;
          return (
            <Fragment key={`${s.startMs}-${i}`}>
              {head && !query && <div className="transcript-q">{head}</div>}
              <button className={`transcript-seg ${i === activeIndex ? "active" : ""}`} data-seg={i} onClick={() => onSeek(s.startMs)}>
                <span className="num seg-time">{formatClock(s.startMs)}</span>
                <span className="seg-text">{highlight(s.text, query)}</span>
              </button>
            </Fragment>
          );
        })}
      </div>
      {isAdmin && (
        <div className="row-actions left">
          <span className="muted small">
            モデル {transcript.model} ・ {transcript.segments.length} 区間
          </span>
          <button className="quiet small" onClick={() => void request()}>
            やり直す
          </button>
        </div>
      )}
    </div>
  );
}
