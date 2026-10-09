// 別の機材(ビデオカメラ・スマートフォン等)で撮った動画の取り込み。
// 同意の記録 → 動画の選択 → (同意があれば)表情の計測 → 送信。

import { useEffect, useRef, useState } from "react";
import { encodeFaceTrack, type FaceTrack } from "../../analysis/faceTrack";
import type { InterviewDetail } from "../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { formatBytes, formatClock } from "../format";
import { ConsentForm } from "../record/ConsentForm";
import { FaceAnalysisRunner } from "../record/FaceAnalysisRunner";
import { gzipBytes, newLocalId } from "../record/localStore";
import { useLeaveGuard, useRouter } from "../router";
import { useSession } from "../session";
import { Loading, Notice, ProgressBar } from "../ui";

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 ** 3;

type Step = "consent" | "choose" | "analyze" | "upload" | "done";

function guessMime(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

export default function ImportPage({ id }: { id: string }) {
  const { settings } = useSession();
  const { navigate } = useRouter();
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ durationMs: number | null; ok: boolean; error: string | null } | null>(null);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const trackRef = useRef<FaceTrack | null>(null);
  const probeRef = useRef<HTMLVideoElement | null>(null);

  useLeaveGuard(step === "upload" || step === "analyze", "取り込みの途中です。このページを離れると最初からやり直しになります。");

  useEffect(() => {
    api
      .interview(id)
      .then((d) => {
        setDetail(d);
        const c = d.interview.consent;
        setStep(c && c.recording && !c.withdrawnAt ? "choose" : "consent");
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [id]);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!detail || !settings) return <Loading />;
  const iv = detail.interview;
  const analysisAllowed = !!iv.consent?.analysis && !iv.consent.withdrawnAt;

  const choose = (f: File | null) => {
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setMeta(null);
    trackRef.current = null;
    if (!f) {
      setUrl(null);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setUrl(null);
      setMeta({ durationMs: null, ok: false, error: "ファイルが大きすぎます(20GBまで)" });
      return;
    }
    setUrl(URL.createObjectURL(f));
  };

  const upload = async () => {
    if (!file) return;
    setStep("upload");
    setUploadError(null);
    const total = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
    setProgress({ sent: 0, total });
    try {
      const created = await api.createRecording(iv.id, {
        clientId: newLocalId(),
        source: "file",
        mimeType: guessMime(file),
        startedAt: new Date(file.lastModified || Date.now()).toISOString(),
        fileName: file.name,
      });
      const rid = created.recording.id;
      const got = new Set(created.received);
      for (let i = 0; i < total; i++) {
        if (got.has(i)) continue;
        const blob = file.slice(i * CHUNK_BYTES, Math.min(file.size, (i + 1) * CHUNK_BYTES));
        for (let attempt = 0; ; attempt++) {
          try {
            await api.putChunk(iv.id, rid, i, blob);
            break;
          } catch (e) {
            const retryable = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 429;
            if (!retryable || attempt >= 5) throw e;
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          }
        }
        setProgress({ sent: i + 1, total });
      }
      await api.completeRecording(iv.id, rid, {
        chunkCount: total,
        durationMs: meta?.durationMs ? Math.round(meta.durationMs) : null,
        endedAt: new Date().toISOString(),
        markers: [],
      });
      if (trackRef.current && analysisAllowed) {
        const gz = await gzipBytes(encodeFaceTrack(trackRef.current));
        await api.putTrack(iv.id, rid, gz);
      }
      setStep("done");
    } catch (e) {
      setUploadError(errorMessage(e));
      setStep("choose");
    }
  };

  return (
    <div className="page narrow">
      <h2>動画の取り込み — {iv.candidate.displayName}</h2>

      {step === "consent" && settings && (
        <>
          <Notice kind="info">取り込む前に、録画と表情の計測への同意を記録してください(紙の同意書で取得した場合はその内容を転記します)。</Notice>
          <ConsentForm
            interview={iv}
            settings={settings}
            onCancel={() => navigate(`/interviews/${id}`)}
            onRecorded={(d) => {
              setDetail(d);
              if (d.interview.consent?.recording) setStep("choose");
              else navigate(`/interviews/${id}`);
            }}
          />
        </>
      )}

      {step === "choose" && (
        <div className="panel pad form">
          <p className="small">
            ビデオカメラやスマートフォンで撮った面接の動画を選んでください。
            {analysisAllowed ? "取り込む前に、この端末で表情を計測します(動画の長さの1/4〜1/2程度の時間がかかります)。" : "表情の計測には同意を得ていないため、映像だけを取り込みます。"}
          </p>
          <input type="file" accept="video/*,.mp4,.mov,.webm,.m4v,.mkv" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
          {file && (
            <div className="muted small">
              {file.name} ・ {formatBytes(file.size)}
              {meta?.durationMs ? ` ・ ${formatClock(meta.durationMs)}` : ""}
            </div>
          )}
          {url && (
            <video
              ref={probeRef}
              className="probe-video"
              src={url}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                const d = Number.isFinite(v.duration) ? v.duration * 1000 : null;
                const ok = v.videoWidth > 0;
                setMeta({ durationMs: d, ok, error: ok ? null : "映像を読み取れません(音声のみのファイル、または未対応の形式です)" });
              }}
              onError={() =>
                setMeta({
                  durationMs: null,
                  ok: false,
                  error: "このブラウザで再生できない形式です。MP4(H.264)などに変換してから取り込んでください",
                })
              }
            />
          )}
          {meta?.error && <Notice kind="error">{meta.error}</Notice>}
          {uploadError && <Notice kind="error">送信に失敗しました: {uploadError}</Notice>}
          <div className="row-actions">
            <button className="quiet" onClick={() => navigate(`/interviews/${id}`)}>
              やめる
            </button>
            {analysisAllowed ? (
              <button className="primary" disabled={!meta?.ok} onClick={() => setStep("analyze")}>
                表情を計測して取り込む
              </button>
            ) : (
              <button className="primary" disabled={!meta?.ok} onClick={() => void upload()}>
                取り込む
              </button>
            )}
          </div>
        </div>
      )}

      {step === "analyze" && url && (
        <div className="panel pad">
          <FaceAnalysisRunner
            src={url}
            startLabel="この顔で計測して取り込む"
            onCancel={() => setStep("choose")}
            onTrack={async (track) => {
              trackRef.current = track;
              await upload();
            }}
          />
        </div>
      )}

      {step === "upload" && (
        <div className="panel pad">
          <p>動画を送信しています。終わるまでこのページを閉じないでください。</p>
          <ProgressBar
            value={progress.total ? progress.sent / progress.total : 0}
            label={file ? `${formatBytes(Math.min(file.size, progress.sent * CHUNK_BYTES))} / ${formatBytes(file.size)}` : ""}
          />
        </div>
      )}

      {step === "done" && (
        <div className="panel pad">
          <Notice kind="ok">取り込みが完了しました。サーバーでの処理が終わると再生できるようになります。</Notice>
          <div className="row-actions">
            <button className="primary" onClick={() => navigate(`/interviews/${id}`)}>
              面接の詳細へ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
