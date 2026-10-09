// 録画の確認: 動画 + 表情のタイムライン + 注目シーン・質問ごとの集計・メモ + 表情の要約。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExpressionSummary } from "../../analysis/expression";
import { decodeFaceTrack, encodeFaceTrack, typicalStepMs, type FaceTrack } from "../../analysis/faceTrack";
import { buildTimelineSeries, type TimelineSeries } from "../../analysis/series";
import type { ExpressionStats, InterviewDetail, Marker, RecordingMeta } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatBytes, formatClock, formatDateTime, formatDuration } from "../format";
import { FaceAnalysisRunner } from "../record/FaceAnalysisRunner";
import { gunzipToBytes, gzipBytes } from "../record/localStore";
import { useSession } from "../session";
import { Notice, useConfirm, useToast } from "../ui";
import { ExpressionSummaryView } from "./ExpressionSummaryView";
import { ReviewTimeline } from "./ReviewTimeline";
import { TranscriptPanel } from "./TranscriptPanel";
import { HighlightList, NotesList, SegmentTable } from "./SceneLists";

const REC_STATUS: Record<RecordingMeta["status"], string> = {
  uploading: "受信中",
  processing: "処理中",
  ready: "再生できます",
  failed: "処理に失敗",
  purged: "保存期間を過ぎたため映像は削除済み",
  deleted: "削除済み",
};

type SideTab = "scenes" | "segments" | "transcript" | "notes" | "marks";

export function ReviewPanel({
  detail,
  setDetail,
  stats,
}: {
  detail: InterviewDetail;
  setDetail: (d: InterviewDetail) => void;
  stats: ExpressionStats | null;
}) {
  const { user, info } = useSession();
  const toast = useToast();
  const iv = detail.interview;
  const recs = iv.recordings.filter((r) => r.status !== "deleted");
  const [rid, setRid] = useState<string | null>(() => (recs.find((r) => r.status === "ready") ?? recs[0])?.id ?? null);
  const rec = recs.find((r) => r.id === rid) ?? recs[0] ?? null;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [summary, setSummary] = useState<ExpressionSummary | null>(null);
  const [series, setSeries] = useState<TimelineSeries | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [reanalyze, setReanalyze] = useState(false);
  const [side, setSide] = useState<SideTab>("scenes");
  const [rate, setRate] = useState(1);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [confirmNode, confirm] = useConfirm();

  const analysisKey = rec ? `${rec.id}:${rec.analysis}:${rec.status}:${rec.durationMs}` : "";
  useEffect(() => {
    setSummary(null);
    setSeries(null);
    setAnalysisError(null);
    if (!rec || rec.analysis !== "ready") return;
    let alive = true;
    (async () => {
      try {
        const [{ summary: s }, gz] = await Promise.all([api.summary(iv.id, rec.id), api.trackGz(iv.id, rec.id).catch(() => null)]);
        if (!alive) return;
        setSummary(s);
        if (gz) {
          const track = decodeFaceTrack(await gunzipToBytes(gz));
          // 解析が粗い録画では、ビンを広げて歯抜けに見えないようにする
          const bin = Math.max(250, Math.ceil((typicalStepMs(track) * 2) / 50) * 50);
          if (alive) setSeries(buildTimelineSeries(track, s.durationMs, bin));
        }
      } catch (e) {
        if (alive) setAnalysisError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey, iv.id]);

  const getTimeMs = useCallback(() => (videoRef.current?.currentTime ?? 0) * 1000, []);
  const seek = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
  }, []);

  const durationMs = rec?.durationMs ?? summary?.durationMs ?? videoDuration ?? 0;
  const playable = rec?.status === "ready";
  const notes = useMemo(() => detail.notes.notes.filter((n) => n.recordingId === rec?.id || n.recordingId === null), [detail.notes, rec]);
  const canAnalyze = !!iv.consent?.analysis && !iv.consent.withdrawnAt && playable;

  if (recs.length === 0) return null;

  const addNote = async (text: string, tMs: number | null) => {
    try {
      const res = await api.addNote(iv.id, { recordingId: tMs === null ? null : rec?.id ?? null, tMs, text });
      setDetail({ ...detail, notes: res.notes });
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      return false;
    }
  };
  const deleteNote = async (noteId: string) => {
    try {
      const res = await api.deleteNote(iv.id, noteId);
      setDetail({ ...detail, notes: res.notes });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const saveMarkers = async (markers: Marker[]) => {
    if (!rec) return;
    try {
      const res = await api.putMarkers(iv.id, rec.id, markers);
      setDetail({
        ...detail,
        interview: { ...iv, recordings: iv.recordings.map((r) => (r.id === rec.id ? res.recording : r)) },
      });
      if (res.summary) setSummary(res.summary);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const onTrack = async (track: FaceTrack) => {
    if (!rec) return;
    try {
      const gz = await gzipBytes(encodeFaceTrack(track));
      const res = await api.putTrack(iv.id, rec.id, gz);
      setDetail({
        ...detail,
        interview: { ...iv, recordings: iv.recordings.map((r) => (r.id === rec.id ? res.recording : r)) },
      });
      setReanalyze(false);
      toast("表情の計測が終わりました");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const reprocess = async () => {
    if (!rec) return;
    try {
      const res = await api.reprocessRecording(iv.id, rec.id);
      setDetail({
        ...detail,
        interview: { ...iv, recordings: iv.recordings.map((r) => (r.id === rec.id ? res.recording : r)) },
      });
      toast("再処理を始めました。しばらくしてから画面を開き直してください");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const deleteRecording = async () => {
    if (!rec) return;
    const ok = await confirm({
      title: "録画を削除しますか?",
      body: "映像と表情の計測データを完全に削除します。元に戻せません。評価・メモは残ります。",
      ok: "削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.deleteRecording(iv.id, rec.id);
      setDetail({
        ...detail,
        interview: { ...iv, recordings: iv.recordings.map((r) => (r.id === rec.id ? res.recording : r)) },
      });
      toast("録画を削除しました");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <section className="panel review" id="review">
      {confirmNode}
      <div className="panel-title">
        録画と表情の計測
        <span className="spacer" />
        {recs.length > 1 &&
          recs.map((r, i) => (
            <button key={r.id} className={`tab small ${r.id === rec?.id ? "active" : ""}`} onClick={() => setRid(r.id)}>
              録画{i + 1}
              {r.durationMs ? `(${formatDuration(r.durationMs)})` : ""}
            </button>
          ))}
      </div>

      {rec && (
        <div className="pad">
          <div className="rec-meta muted small">
            {formatDateTime(rec.startedAt)} ・ {rec.source === "file" ? `取り込み${rec.originalName ? `(${rec.originalName})` : ""}` : "この画面で録画"} ・{" "}
            {formatDuration(rec.durationMs)} ・ {formatBytes(rec.sizeBytes)} ・ {rec.createdByName}
            {rec.status !== "ready" && <span className={`rec-status st-${rec.status}`}> ・ {REC_STATUS[rec.status]}</span>}
            {rec.status === "ready" && !rec.indexed && <span> ・ シーク用の索引なし(移動に時間がかかることがあります)</span>}
          </div>

          {(rec.status === "uploading" || rec.status === "processing") && (
            <Notice kind="info">
              {rec.status === "uploading"
                ? "録画を受信しています。録画した端末で送信が終わると再生できるようになります。"
                : "録画を処理しています。まもなく再生できるようになります。"}
            </Notice>
          )}
          {rec.status === "failed" && (
            <Notice kind="error">
              録画の処理に失敗しました: {rec.error ?? "不明なエラー"}
              {user?.role === "admin" && rec.chunkCount !== null && (
                <button className="small-btn" onClick={() => void reprocess()}>
                  再処理する
                </button>
              )}
            </Notice>
          )}
          {rec.status === "purged" && (
            <Notice kind="info">保存期間を過ぎたため、映像と顔の時系列データは削除されています。表情の集計(数値)は残っています。</Notice>
          )}

          {playable && (
            <div className="review-grid">
              <div className="review-video">
                {/* 再生用 MP4(H.264)があれば先に。iPhone の Safari でも再生できる。
                    再生できない形式はブラウザが飛ばして次の候補(元の録画)を使う */}
                <video
                  key={`${rec.id}:${rec.mp4Ready}`}
                  ref={videoRef}
                  controls
                  preload="metadata"
                  playsInline
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    setVideoDuration(Number.isFinite(d) ? d * 1000 : null);
                    e.currentTarget.playbackRate = rate;
                  }}
                >
                  {rec.mp4Ready && <source src={api.mp4Url(iv.id, rec.id)} type='video/mp4; codecs="avc1.4D401F, mp4a.40.2"' />}
                  <source src={api.videoUrl(iv.id, rec.id)} type={sourceType(rec.mimeType)} />
                </video>
                <div className="row-actions left">
                  <span className="muted small">再生速度</span>
                  {[1, 1.5, 2].map((r) => (
                    <button
                      key={r}
                      className={`tab small ${rate === r ? "active" : ""}`}
                      onClick={() => {
                        setRate(r);
                        if (videoRef.current) videoRef.current.playbackRate = r;
                      }}
                    >
                      ×{r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="review-side">
                <div className="tabs">
                  <button className={`tab ${side === "scenes" ? "active" : ""}`} onClick={() => setSide("scenes")}>
                    注目シーン
                  </button>
                  <button className={`tab ${side === "segments" ? "active" : ""}`} onClick={() => setSide("segments")}>
                    質問ごと
                  </button>
                  {rec.transcript !== "none" || info?.features.transcription ? (
                    <button className={`tab ${side === "transcript" ? "active" : ""}`} onClick={() => setSide("transcript")}>
                      文字起こし
                    </button>
                  ) : null}
                  <button className={`tab ${side === "notes" ? "active" : ""}`} onClick={() => setSide("notes")}>
                    メモ{detail.notes.notes.length > 0 ? ` ${detail.notes.notes.length}` : ""}
                  </button>
                  <button className={`tab ${side === "marks" ? "active" : ""}`} onClick={() => setSide("marks")}>
                    区切り
                  </button>
                </div>
                <div className="side-body">
                  {side === "scenes" &&
                    (summary ? (
                      <HighlightList highlights={summary.highlights} onSeek={seek} />
                    ) : (
                      <MarkerJumpList markers={rec.markers} onSeek={seek} />
                    ))}
                  {side === "segments" &&
                    (summary ? <SegmentTable summary={summary} onSeek={seek} /> : <div className="muted small pad">表情の計測データがありません。</div>)}
                  {side === "transcript" && (
                    <TranscriptPanel
                      iid={iv.id}
                      rec={rec}
                      onSeek={seek}
                      getTimeMs={getTimeMs}
                      onChanged={(r) =>
                        setDetail({ ...detail, interview: { ...iv, recordings: iv.recordings.map((x) => (x.id === r.id ? r : x)) } })
                      }
                    />
                  )}
                  {side === "notes" && (
                    <NotesList
                      notes={notes}
                      hiddenCount={detail.notes.hiddenCount}
                      recordingId={rec.id}
                      canStamp={playable}
                      getTimeMs={getTimeMs}
                      onSeek={seek}
                      onAdd={addNote}
                      onDelete={deleteNote}
                    />
                  )}
                  {side === "marks" && (
                    <MarkerEditor markers={rec.markers} questions={iv.questions} getTimeMs={getTimeMs} onSeek={seek} onSave={saveMarkers} />
                  )}
                </div>
              </div>
            </div>
          )}

          {(playable || summary) && durationMs > 0 && (
            <ReviewTimeline
              series={series}
              durationMs={durationMs}
              markers={rec.markers}
              notes={notes}
              highlights={summary?.highlights ?? []}
              getTimeMs={getTimeMs}
              onSeek={seek}
            />
          )}

          {analysisError && <Notice kind="error">表情の計測結果を読み込めません: {analysisError}</Notice>}
          {summary && <ExpressionSummaryView summary={summary} stats={stats} interviewId={iv.id} />}

          {!iv.consent?.analysis && (
            <Notice kind="info">表情の計測には同意を得ていないため、この録画は計測していません。</Notice>
          )}
          {canAnalyze && rec.analysis !== "ready" && !reanalyze && (
            <Notice kind="info">
              この録画はまだ表情を計測していません。
              <button className="primary small-btn" onClick={() => setReanalyze(true)}>
                録画から表情を計測する
              </button>
            </Notice>
          )}
          {reanalyze && rec && (
            <div className="panel inset pad">
              <h4>録画から表情を計測</h4>
              <FaceAnalysisRunner src={api.videoUrl(iv.id, rec.id)} onTrack={onTrack} onCancel={() => setReanalyze(false)} />
            </div>
          )}

          {user?.role === "admin" && (
            <div className="row-actions admin-tools">
              {canAnalyze && rec.analysis === "ready" && !reanalyze && (
                <button className="quiet small" onClick={() => setReanalyze(true)}>
                  表情を計測し直す
                </button>
              )}
              {rec.status !== "processing" && (
                <button className="quiet small danger-text" onClick={() => void deleteRecording()}>
                  この録画を削除
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** <source type> 用。コーデック指定つきの WebM はそのまま、それ以外は形式だけ */
function sourceType(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "video/quicktime") return "video/mp4";
  if (base === "video/webm" && /codecs=/i.test(mime)) {
    const codecs = /codecs=([^;]+)/i.exec(mime)?.[1]?.replace(/"/g, "") ?? "";
    return `video/webm; codecs="${codecs}"`;
  }
  return base;
}

function MarkerJumpList({ markers, onSeek }: { markers: Marker[]; onSeek: (ms: number) => void }) {
  if (markers.length === 0) return <div className="muted small pad">表情の計測データ・区切りがありません。</div>;
  return (
    <ul className="scene-list">
      {markers.map((m) => (
        <li key={m.id}>
          <button className="scene" onClick={() => onSeek(m.tMs)}>
            <span className="scene-icon">{m.kind === "bookmark" ? "★" : "Q"}</span>
            <span className="num scene-time">{formatClock(m.tMs)}</span>
            <span className="scene-label">{m.kind === "bookmark" ? "印" : m.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 録画のあとから質問の区切りを直す(押し忘れ・押し間違い) */
function MarkerEditor({
  markers,
  questions,
  getTimeMs,
  onSeek,
  onSave,
}: {
  markers: Marker[];
  questions: string[];
  getTimeMs: () => number;
  onSeek: (ms: number) => void;
  onSave: (m: Marker[]) => Promise<void>;
}) {
  const [label, setLabel] = useState(questions[0] ?? "__custom");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  // ボタンに出す「いまの時刻」を更新する
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const sorted = markers.slice().sort((a, b) => a.tMs - b.tMs);
  const save = async (next: Marker[]) => {
    setBusy(true);
    await onSave(next);
    setBusy(false);
  };
  return (
    <div className="marker-editor">
      <ul className="marker-list">
        {sorted.map((m) => (
          <li key={m.id}>
            <button className="quiet num" onClick={() => onSeek(m.tMs)}>
              {formatClock(m.tMs)}
            </button>
            <span>{m.kind === "bookmark" ? "★ 印" : m.label}</span>
            <button className="quiet small" disabled={busy} onClick={() => void save(markers.filter((x) => x.id !== m.id))}>
              削除
            </button>
          </li>
        ))}
      </ul>
      <div className="form compact">
        <span className="muted small">いま再生している時刻に区切りを追加</span>
        <select value={label} onChange={(e) => setLabel(e.target.value)}>
          {questions.map((q, i) => (
            <option key={i} value={q}>
              Q{i + 1} {q}
            </option>
          ))}
          <option value="__custom">その他(入力)</option>
          <option value="__bookmark">★ 印</option>
        </select>
        {label === "__custom" && <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="質問の名前" maxLength={100} />}
        <button
          className="primary"
          disabled={busy || (label === "__custom" && !custom.trim())}
          onClick={() => {
            const t = Math.round(getTimeMs());
            const m: Marker =
              label === "__bookmark"
                ? { id: `m${Date.now().toString(36)}`, tMs: t, kind: "bookmark", label: "★" }
                : { id: `m${Date.now().toString(36)}`, tMs: t, kind: "question", label: label === "__custom" ? custom.trim() : label };
            void save([...markers, m]);
            setCustom("");
          }}
        >
          {formatClock(getTimeMs())} に追加
        </button>
        <span className="muted small">区切りを変えると、質問ごとの集計を計算し直します。</span>
      </div>
    </div>
  );
}
