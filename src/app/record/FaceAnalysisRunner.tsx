// 録画済みの動画から表情を計測する(動画の取り込み・サーバーの録画の再計測で共通)。
// 1) 動画の一場面で顔を検出し、候補者の顔を選ぶ 2) 再生しながら計測する。

import { useEffect, useRef, useState } from "react";
import { boxCenter, pickBoxAt, type Box, type TargetState } from "../../analysis/candidate";
import type { FaceTrack } from "../../analysis/faceTrack";
import type { FaceEngine } from "../../engine/faceEngine";
import { errorMessage } from "../api";
import { formatClock } from "../format";
import { Notice, ProgressBar } from "../ui";
import { analyzeVideo, detectFacesAt, type AnalyzerStatus, type FileAnalysisProgress } from "./analyzers";
import { loadFaceEngine } from "./faceEngineLoader";
import { FaceOverlay } from "./FaceOverlay";

type Phase = "loading" | "pick" | "running" | "done" | "error";

export function FaceAnalysisRunner({
  src,
  onTrack,
  onCancel,
  startLabel = "この顔で計測を開始",
}: {
  src: string;
  onTrack: (track: FaceTrack) => Promise<void>;
  onCancel: () => void;
  startLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<FaceEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [engineProgress, setEngineProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AnalyzerStatus>({ boxes: [], candidate: -1, lastSeenAt: 0, fps: 0, frames: 0 });
  const [target, setTarget] = useState<TargetState | null>(null);
  const [pickTime, setPickTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [progress, setProgress] = useState<FileAnalysisProgress | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  // モデルと動画の読み込み → 最初の場面で顔を検出
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const engine = await loadFaceEngine((p) => alive && setEngineProgress(p.fraction));
        if (!alive) return;
        engineRef.current = engine;
        const video = videoRef.current!;
        if (video.readyState < 1) {
          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("動画を読み込めません。形式を確認してください(Chrome で再生できる MP4 / WebM)"));
          });
        }
        const d = Number.isFinite(video.duration) ? video.duration : null;
        setDuration(d);
        const t = d ? Math.min(5, d / 10) : 1;
        setPickTime(t);
        await detectAt(t);
        if (alive) setPhase("pick");
      } catch (e) {
        if (alive) {
          setError(errorMessage(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const detectAt = async (t: number) => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video) return;
    const faces = await detectFacesAt(engine, video, t);
    const boxes: Box[] = faces.map((f) => f.box);
    let cand = -1;
    if (boxes.length > 0) {
      cand = 0;
      for (let i = 1; i < boxes.length; i++) if (boxes[i].y1 - boxes[i].y0 > boxes[cand].y1 - boxes[cand].y0) cand = i;
    }
    setStatus({ boxes, candidate: cand, lastSeenAt: 0, fps: 0, frames: 0 });
    setTarget(cand >= 0 ? boxCenter(boxes[cand]) : null);
  };

  const pick = (x: number, y: number) => {
    const v = videoRef.current;
    const idx = pickBoxAt(status.boxes, x, y, (v?.videoWidth || 16) / (v?.videoHeight || 9));
    if (idx < 0) return;
    setStatus({ ...status, candidate: idx });
    setTarget(boxCenter(status.boxes[idx]));
  };

  const run = async () => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("running");
    setStartedAt(performance.now());
    try {
      const track = await analyzeVideo({ engine, video, target, signal: ac.signal, onProgress: setProgress });
      setPhase("done");
      await onTrack(track);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setPhase("pick");
        return;
      }
      setError(errorMessage(e));
      setPhase("error");
    }
  };

  const eta = (() => {
    if (!progress?.fraction || progress.fraction < 0.02) return null;
    const elapsed = performance.now() - startedAt;
    return (elapsed / progress.fraction) * (1 - progress.fraction);
  })();

  return (
    <div className="analysis-runner">
      <div className="stage-box">
        <video ref={videoRef} src={src} muted playsInline preload="auto" />
        {phase === "pick" && <FaceOverlay video={videoRef.current} status={status} onPick={pick} />}
        {phase === "loading" && <div className="preview-cover">準備しています {Math.round(engineProgress * 100)}%</div>}
      </div>

      {phase === "pick" && (
        <>
          {status.boxes.length === 0 ? (
            <Notice kind="warn">この場面では顔が見つかりませんでした。下のつまみで候補者が映っている場面を選んでください。</Notice>
          ) : (
            <p className="small">
              緑の枠が「候補者」です。違う人が選ばれているときは、候補者の顔をクリックしてください。
              {status.boxes.length > 1 && `(${status.boxes.length}人の顔が映っています)`}
            </p>
          )}
          {duration !== null && (
            <div className="row-actions left">
              <input
                type="range"
                min={0}
                max={duration}
                step={0.5}
                value={pickTime}
                onChange={(e) => setPickTime(Number(e.target.value))}
                onMouseUp={() => void detectAt(pickTime)}
                onTouchEnd={() => void detectAt(pickTime)}
                onKeyUp={() => void detectAt(pickTime)}
                className="grow"
                aria-label="顔を検出する場面"
              />
              <span className="num small">{formatClock(pickTime * 1000)}</span>
            </div>
          )}
          <div className="row-actions">
            <button className="quiet" onClick={onCancel}>
              やめる
            </button>
            <button className="primary" disabled={!target} onClick={() => void run()}>
              {startLabel}
            </button>
          </div>
        </>
      )}

      {phase === "running" && (
        <>
          <ProgressBar
            value={progress?.fraction ?? 0}
            label={progress ? `${formatClock(progress.mediaTimeMs)} / ${formatClock(progress.durationMs)}` : "開始中"}
          />
          <div className="muted small num">
            再生速度 ×{(progress?.playbackRate ?? 1).toFixed(1)} ・ 顔を計測できた割合 {Math.round((progress?.detectRate ?? 0) * 100)}%
            {eta !== null && ` ・ 残り 約${Math.max(1, Math.round(eta / 60_000))}分`}
          </div>
          <Notice kind="info">計測中はこのタブを表示したままにしてください(別のタブに切り替えると一時停止します)。</Notice>
          <div className="row-actions">
            <button className="quiet" onClick={() => abortRef.current?.abort()}>
              中止
            </button>
          </div>
        </>
      )}

      {phase === "done" && <Notice kind="ok">計測が終わりました。結果を保存しています。</Notice>}
      {phase === "error" && (
        <>
          <Notice kind="error">{error}</Notice>
          <div className="row-actions">
            <button onClick={onCancel}>閉じる</button>
          </div>
        </>
      )}
    </div>
  );
}
