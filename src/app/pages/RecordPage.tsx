// 当日の撮影: 同意 → 撮影準備(カメラ・候補者の顔の選択)→ 録画 → 送信。
// 映像はこの端末に保存しながら、録画中から順次サーバーへ送る。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickBoxAt, boxCenter } from "../../analysis/candidate";
import { AudioEngine } from "../../engine/audioEngine";
import type { InterviewDetail, Marker } from "../../shared/types";
import { api, errorMessage } from "../api";
import { formatBytes, formatClock } from "../format";
import { useUploads } from "../Layout";
import { ConsentForm } from "../record/ConsentForm";
import { FaceOverlay } from "../record/FaceOverlay";
import { LiveAnalyzer } from "../record/analyzers";
import { loadFaceEngine } from "../record/faceEngineLoader";
import { requestPersistence, storageEstimate } from "../record/localStore";
import {
  cameraErrorMessage,
  listDevices,
  loadDeviceChoice,
  openCamera,
  saveDeviceChoice,
  stopStream,
  type DeviceChoice,
} from "../record/media";
import { LocalRecorder, pickMimeType } from "../record/recorder";
import { uploader } from "../record/uploader";
import { useLeaveGuard, useRouter } from "../router";
import { useSession } from "../session";
import { Field, Loading, Notice, ProgressBar, useConfirm } from "../ui";

type Step = "loading" | "consent" | "setup" | "recording" | "finished";

const MAX_RECORDING_MS = 3 * 3600_000;
const TRACK_SAVE_MS = 20_000;
const FACE_LOST_WARN_MS = 5_000;

type Checks = {
  face: { ok: boolean | null; text: string };
  size: { ok: boolean | null; text: string };
  light: { ok: boolean | null; text: string };
  others: number;
  mic: { ok: boolean | null; level: number };
};

export default function RecordPage({ id }: { id: string }) {
  const { settings } = useSession();
  const { navigate } = useRouter();
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("loading");

  useEffect(() => {
    api
      .interview(id)
      .then((d) => {
        setDetail(d);
        const c = d.interview.consent;
        setStep(c && c.recording && !c.withdrawnAt ? "setup" : "consent");
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [id]);

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!detail || !settings || step === "loading") return <Loading />;
  const iv = detail.interview;

  if (iv.decision) {
    return (
      <div className="page narrow">
        <Notice kind="warn">この面接は判定済みのため、録画を追加できません。</Notice>
      </div>
    );
  }

  if (step === "consent") {
    return (
      <div className="page narrow">
        <div className="page-head">
          <h2>同意の確認 — {iv.candidate.displayName}</h2>
        </div>
        {iv.consent && !iv.consent.recording && (
          <Notice kind="warn">前回は「録画しない」として記録されています。同意を取り直す場合は、もう一度入力してください。</Notice>
        )}
        <ConsentForm
          interview={iv}
          settings={settings}
          onCancel={() => navigate(`/interviews/${id}`)}
          onRecorded={(d) => {
            setDetail(d);
            if (d.interview.consent?.recording) setStep("setup");
            else navigate(`/interviews/${id}`);
          }}
        />
      </div>
    );
  }

  return <Studio detail={detail} step={step} setStep={setStep} />;
}

// ---------------------------------------------------------------------------
// 撮影準備 〜 録画 〜 送信
// ---------------------------------------------------------------------------

function Studio({ detail, step, setStep }: { detail: InterviewDetail; step: Step; setStep: (s: Step) => void }) {
  const { settings } = useSession();
  const { navigate } = useRouter();
  const iv = detail.interview;
  const analysisAllowed = !!iv.consent?.analysis;
  const quality = settings!.recording;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const analyzerRef = useRef<LiveAnalyzer | null>(null);
  const recorderRef = useRef<LocalRecorder | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  const [choice, setChoice] = useState<DeviceChoice>(loadDeviceChoice);
  const [devices, setDevices] = useState<{ videos: MediaDeviceInfo[]; audios: MediaDeviceInfo[] }>({ videos: [], audios: [] });
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [engineState, setEngineState] = useState<{ stage: string; fraction: number; error: string | null; ready: boolean }>({
    stage: "",
    fraction: 0,
    error: null,
    ready: false,
  });
  const [checks, setChecks] = useState<Checks | null>(null);
  const [hidePreview, setHidePreview] = useState(false);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [currentQ, setCurrentQ] = useState<number | null>(null);
  const [customQ, setCustomQ] = useState("");
  const [faceLostMs, setFaceLostMs] = useState(0);
  const [localId, setLocalId] = useState<string | null>(null);
  const [hiddenNotice, setHiddenNotice] = useState(false);
  const [confirmNode, confirm] = useConfirm();

  useLeaveGuard(
    step === "recording",
    "録画中です。このページを離れると録画が止まります。録画を終了してから移動してください。",
  );

  // ---------------------------------------------------------------- カメラ
  const startCamera = useCallback(async (c: DeviceChoice) => {
    setCameraError(null);
    setCameraReady(false);
    analyzerRef.current?.stop();
    analyzerRef.current = null;
    audioRef.current?.close();
    audioRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    try {
      const stream = await openCamera(c, quality);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        await new Promise<void>((resolve) => {
          if (video.videoWidth > 0) resolve();
          else video.onloadedmetadata = () => resolve();
          setTimeout(resolve, 3000);
        });
      }
      try {
        audioRef.current = await AudioEngine.create(stream);
      } catch (e) {
        console.warn("[record] 音量の計測を開始できません", e);
      }
      setDevices(await listDevices());
      setCameraReady(true);
    } catch (e) {
      setCameraError(cameraErrorMessage(e));
    }
  }, [quality]);

  useEffect(() => {
    void startCamera(choice);
    void storageEstimate().then(setStorage);
    return () => {
      // 録画中に画面を離れた場合も、そこまでの録画は保存して送信する
      const track = analyzerRef.current?.stop() ?? null;
      const r = recorderRef.current;
      if (r && !r.isStopped) void r.stop(track);
      uploader.activeRecording = null;
      audioRef.current?.close();
      stopStream(streamRef.current);
      void wakeRef.current?.release().catch(() => undefined);
    };
    // 機器の切り替えは changeDevice から行う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeDevice = (patch: Partial<DeviceChoice>) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    saveDeviceChoice(next);
    void startCamera(next);
  };

  // ---------------------------------------------------------------- 顔の計測(同意がある場合のみ)
  useEffect(() => {
    if (!analysisAllowed || !cameraReady || step === "finished") return;
    let alive = true;
    loadFaceEngine((p) => alive && setEngineState((s) => ({ ...s, stage: p.stage, fraction: p.fraction })))
      .then((engine) => {
        if (!alive || !videoRef.current) return;
        if (!analyzerRef.current) {
          const a = new LiveAnalyzer(engine, videoRef.current, audioRef.current);
          analyzerRef.current = a;
          a.run();
        }
        setEngineState((s) => ({ ...s, ready: true, error: null }));
      })
      .catch((e) => {
        if (alive) setEngineState((s) => ({ ...s, error: errorMessage(e) }));
      });
    return () => {
      alive = false;
    };
  }, [analysisAllowed, cameraReady, step]);

  // ---------------------------------------------------------------- 準備のチェック(4Hz)
  useEffect(() => {
    if (!cameraReady) return;
    const lumaCanvas = document.createElement("canvas");
    lumaCanvas.width = 64;
    lumaCanvas.height = 36;
    let micPeakAt = 0;
    let micLevel = 0;
    let seenHistory: boolean[] = [];
    let lastLuma: number | null = null;
    let lumaAt = 0;
    const id = setInterval(() => {
      const now = performance.now();
      const audio = audioRef.current;
      if (audio) {
        const t = audio.tick(now);
        micLevel = Math.max(t.rms, micLevel * 0.85);
        if (t.rms > 0.02) micPeakAt = now;
      }
      const a = analyzerRef.current;
      const st = a?.status;
      const cand = st && st.candidate >= 0 ? st.boxes[st.candidate] : null;
      seenHistory.push(!!cand);
      if (seenHistory.length > 12) seenHistory = seenHistory.slice(-12);
      const seenRate = seenHistory.filter(Boolean).length / seenHistory.length;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && now - lumaAt > 1000) {
        lumaAt = now;
        lastLuma = sampleLuma(lumaCanvas, video, cand);
      }
      const h = cand ? cand.y1 - cand.y0 : 0;
      setChecks({
        face: !a
          ? { ok: null, text: analysisAllowed ? "準備中" : "計測しません" }
          : seenRate >= 0.7
            ? { ok: true, text: "候補者の顔を検出しています" }
            : { ok: false, text: "顔が見つかりません。カメラの向きを調整してください" },
        size: !cand
          ? { ok: null, text: "—" }
          : h >= 0.12
            ? { ok: true, text: `映像の高さの ${Math.round(h * 100)}%` }
            : { ok: false, text: `映像の高さの ${Math.round(h * 100)}%。カメラを近づけるかズームしてください(12%以上)` },
        light:
          lastLuma === null
            ? { ok: null, text: "—" }
            : lastLuma < 70
              ? { ok: false, text: "暗すぎます。顔の正面から光が当たるようにしてください" }
              : lastLuma > 215
                ? { ok: false, text: "明るすぎます。強い光が顔に直接当たらないようにしてください" }
                : { ok: true, text: "適切です" },
        others: st ? Math.max(0, st.boxes.length - (cand ? 1 : 0)) : 0,
        mic: { ok: now - micPeakAt < 8000 ? true : null, level: micLevel },
      });
      if (step === "recording" && a) {
        setFaceLostMs(st && st.lastSeenAt > 0 ? now - st.lastSeenAt : 0);
      }
    }, 250);
    return () => clearInterval(id);
  }, [cameraReady, analysisAllowed, step]);

  const pickCandidate = (x: number, y: number) => {
    const a = analyzerRef.current;
    if (!a) return;
    const idx = pickBoxAt(a.status.boxes, x, y, (videoRef.current?.videoWidth || 16) / (videoRef.current?.videoHeight || 9));
    if (idx < 0) return;
    const c = boxCenter(a.status.boxes[idx]);
    a.setTarget(c);
  };

  // ---------------------------------------------------------------- 録画
  const acquireWakeLock = useCallback(async () => {
    try {
      wakeRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      wakeRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (step !== "recording") return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void acquireWakeLock();
        setHiddenNotice(true);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [step, acquireWakeLock]);

  const startRecording = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    setStarting(true);
    setWarning(null);
    try {
      await requestPersistence();
      const recorder = new LocalRecorder(stream, {
        interviewId: iv.id,
        candidateName: iv.candidate.displayName,
        analysisAllowed,
        videoBitsPerSecond: quality.videoBitsPerSecond,
      });
      recorder.onWarning = (m) => setWarning(m);
      recorderRef.current = recorder;
      const t0 = await recorder.start();
      analyzerRef.current?.beginRecording(t0);
      uploader.activeRecording = recorder.localId;
      setLocalId(recorder.localId);
      setMarkers([]);
      setCurrentQ(null);
      await acquireWakeLock();
      setStep("recording");
    } catch (e) {
      setWarning(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const track = analyzerRef.current?.stop() ?? null;
    analyzerRef.current = null;
    await recorder.stop(track);
    uploader.activeRecording = null;
    void wakeRef.current?.release().catch(() => undefined);
    wakeRef.current = null;
    audioRef.current?.close();
    audioRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStep("finished");
  }, [setStep]);

  // 経過時間・顔トラックの途中保存・上限時間
  useEffect(() => {
    if (step !== "recording") return;
    const tick = setInterval(() => {
      const r = recorderRef.current;
      if (!r) return;
      const ms = r.elapsedMs();
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) void stopRecording();
    }, 500);
    const save = setInterval(() => {
      const snap = analyzerRef.current?.snapshot();
      if (snap && snap.count > 0) void recorderRef.current?.saveTrack(snap).catch(() => undefined);
    }, TRACK_SAVE_MS);
    return () => {
      clearInterval(tick);
      clearInterval(save);
    };
  }, [step, stopRecording]);

  const addMarker = useCallback((kind: Marker["kind"], label: string, qIndex: number | null = null) => {
    const r = recorderRef.current;
    if (!r) return;
    r.addMarker(kind, label);
    setMarkers(r.markerList);
    if (kind === "question") setCurrentQ(qIndex);
  }, []);

  const removeMarker = (mid: string) => {
    const r = recorderRef.current;
    if (!r) return;
    r.removeMarker(mid);
    setMarkers(r.markerList);
  };

  // キーボード: N = 次の質問 / B = 印
  useEffect(() => {
    if (step !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "b" || e.key === "B") addMarker("bookmark", "★");
      if (e.key === "n" || e.key === "N") {
        const next = currentQ === null ? 0 : currentQ + 1;
        if (next < iv.questions.length) addMarker("question", iv.questions[next], next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, currentQ, iv.questions, addMarker]);

  const confirmStop = async () => {
    const ok = await confirm({
      title: "録画を終了しますか?",
      body: "終了すると、残りの録画データをサーバーへ送信します。送信が終わるまでこの端末の電源を切らないでください。",
      ok: "録画を終了する",
    });
    if (ok) await stopRecording();
  };

  const uploads = useUploads();
  const upload = useMemo(() => uploads.find((u) => u.localId === localId) ?? null, [uploads, localId]);
  const freeSpace = storage ? storage.quota - storage.usage : null;
  const mime = useMemo(() => pickMimeType(), []);

  // ---------------------------------------------------------------- 表示
  if (step === "finished") {
    const done = upload?.phase === "done";
    const frac = upload && upload.chunkCount > 0 ? upload.uploadedChunks / upload.chunkCount : 0;
    return (
      <div className="page narrow">
        <h2>録画を終了しました — {iv.candidate.displayName}</h2>
        <div className="panel pad">
          {done ? (
            <Notice kind="ok">送信が完了しました。録画はサーバーで処理されたあと、面接の詳細画面で再生できるようになります。</Notice>
          ) : (
            <>
              <p>録画データを送信しています。完了まで、この端末の電源を切らないでください。</p>
              <ProgressBar value={frac} label={upload ? `${upload.uploadedChunks}/${upload.chunkCount}` : "準備中"} />
              {upload?.error && <Notice kind={upload.phase === "error" ? "error" : "warn"}>{upload.error}</Notice>}
              <p className="muted small">
                このページを離れても、送信はこの端末で続きます(画面上部に「録画を送信中」と表示されます)。
              </p>
            </>
          )}
          <div className="row-actions">
            <button className="primary" onClick={() => navigate(`/interviews/${iv.id}`)}>
              面接の詳細へ(評価の入力)
            </button>
          </div>
        </div>
      </div>
    );
  }

  const recording = step === "recording";
  const lostWarn = recording && analysisAllowed && faceLostMs > FACE_LOST_WARN_MS;

  return (
    <div className={`studio ${recording ? "is-recording" : ""}`}>
      {confirmNode}
      <div className="studio-head">
        {recording ? (
          <>
            <span className="rec-dot" aria-hidden />
            <span className="rec-label">録画中</span>
            <span className="rec-clock num">{formatClock(elapsed)}</span>
          </>
        ) : (
          <span className="studio-title">撮影の準備</span>
        )}
        <span className="studio-cand">{iv.candidate.displayName}</span>
        <span className="spacer" />
        {!analysisAllowed && <span className="badge">表情の計測なし(同意なし)</span>}
        {recording && upload && (
          <span className="muted small num">
            送信 {upload.uploadedChunks}/{upload.chunkCount}
          </span>
        )}
      </div>

      <div className="studio-grid">
        <div className="studio-stage">
          <div className={`stage-box ${hidePreview ? "hidden-preview" : ""}`}>
            <video ref={videoRef} muted playsInline autoPlay />
            {analysisAllowed && (
              <FaceOverlay
                video={videoRef.current}
                status={analyzerRef.current?.status ?? null}
                onPick={recording ? undefined : pickCandidate}
              />
            )}
            {hidePreview && <div className="preview-cover">プレビューを隠しています(録画は続いています)</div>}
            {!cameraReady && !cameraError && <div className="preview-cover">カメラを起動しています</div>}
          </div>
          {lostWarn && <Notice kind="warn">候補者の顔が {Math.round(faceLostMs / 1000)} 秒間映っていません。カメラの向きを確認してください。</Notice>}
          {cameraError && (
            <Notice kind="error">
              {cameraError}
              <div className="row-actions">
                <button onClick={() => void startCamera(choice)}>再試行</button>
              </div>
            </Notice>
          )}
          <div className="row-actions left">
            <button className="quiet" onClick={() => setHidePreview((v) => !v)}>
              {hidePreview ? "プレビューを表示" : "プレビューを隠す"}
            </button>
            {!recording && analysisAllowed && <span className="muted small">候補者以外の顔が選ばれているときは、候補者の顔をクリックしてください。</span>}
          </div>
        </div>

        <div className="studio-side">
          {!recording ? (
            <>
              <div className="panel">
                <div className="panel-title">機器</div>
                <div className="pad form">
                  <Field label="カメラ">
                    <select value={choice.videoId ?? ""} onChange={(e) => changeDevice({ videoId: e.target.value || null })}>
                      <option value="">既定のカメラ</option>
                      {devices.videos.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `カメラ ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="マイク">
                    <select value={choice.audioId ?? ""} onChange={(e) => changeDevice({ audioId: e.target.value || null })}>
                      <option value="">既定のマイク</option>
                      {devices.audios.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `マイク ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>

              <div className="panel">
                <div className="panel-title">確認</div>
                <ul className="checklist">
                  {analysisAllowed && (
                    <>
                      <CheckItem label="候補者の顔" ok={checks?.face.ok ?? null} text={engineState.error ? `計測を開始できません: ${engineState.error}` : !engineState.ready ? `${engineState.stage || "モデルを準備中"} ${Math.round(engineState.fraction * 100)}%` : checks?.face.text ?? "—"} />
                      <CheckItem label="顔の大きさ" ok={checks?.size.ok ?? null} text={checks?.size.text ?? "—"} />
                      <CheckItem label="明るさ" ok={checks?.light.ok ?? null} text={checks?.light.text ?? "—"} />
                      {checks && checks.others > 0 && (
                        <li className="check-item info">
                          <span className="mark">i</span>
                          <span>候補者以外に {checks.others} 人の顔が映っています。枠の色で候補者が選ばれているか確認してください。</span>
                        </li>
                      )}
                    </>
                  )}
                  <li className={`check-item ${checks?.mic.ok ? "pass" : "wait"}`}>
                    <span className="mark">{checks?.mic.ok ? "●" : "○"}</span>
                    <span className="name">マイク</span>
                    <span className="meter-bar">
                      <span style={{ width: `${Math.min(100, Math.round((checks?.mic.level ?? 0) * 600))}%` }} />
                    </span>
                  </li>
                  <li className="check-item muted small">
                    <span className="mark">・</span>
                    <span>
                      端末の空き容量: {freeSpace === null ? "不明" : formatBytes(freeSpace)}
                      {freeSpace !== null && freeSpace < 2 * 1024 ** 3 && <span className="warn-text">(少なめです)</span>}
                      {" / "}形式: {mime || "未対応"}
                    </span>
                  </li>
                </ul>
              </div>

              <Notice kind="info">
                カメラは面接官の間から候補者の顔に向けて置いてください。画面が候補者に見えると気が散るため、外付けカメラの使用をおすすめします。
              </Notice>
              {warning && <Notice kind="error">{warning}</Notice>}
              <div className="row-actions">
                <button className="quiet" onClick={() => navigate(`/interviews/${iv.id}`)}>
                  やめる
                </button>
                <button className="primary big" disabled={!cameraReady || starting || !mime} onClick={() => void startRecording()}>
                  {starting ? "開始しています" : "録画を開始"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="panel">
                <div className="panel-title">
                  いまの質問<span className="muted small">(N キーで次へ)</span>
                </div>
                <div className="question-buttons">
                  {iv.questions.map((q, i) => {
                    const asked = markers.some((m) => m.kind === "question" && m.label === q);
                    return (
                      <button
                        key={i}
                        className={`qbtn ${currentQ === i ? "current" : ""} ${asked ? "asked" : ""}`}
                        onClick={() => addMarker("question", q, i)}
                      >
                        <span className="num qno">Q{i + 1}</span>
                        {q}
                      </button>
                    );
                  })}
                  <form
                    className="custom-q"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!customQ.trim()) return;
                      addMarker("question", customQ.trim(), null);
                      setCustomQ("");
                    }}
                  >
                    <input placeholder="その他の質問(入力して Enter)" value={customQ} onChange={(e) => setCustomQ(e.target.value)} maxLength={100} />
                  </form>
                </div>
              </div>

              <button className="bookmark-btn" onClick={() => addMarker("bookmark", "★")}>
                ★ この場面に印をつける <span className="muted small">(B キー)</span>
              </button>

              {markers.length > 0 && (
                <div className="panel">
                  <div className="panel-title">記録した区切り</div>
                  <ul className="marker-list">
                    {markers
                      .slice()
                      .reverse()
                      .map((m) => (
                        <li key={m.id}>
                          <span className="num">{formatClock(m.tMs)}</span>
                          <span>{m.kind === "bookmark" ? "★ 印" : m.label}</span>
                          <button className="quiet small" onClick={() => removeMarker(m.id)} aria-label="取り消す">
                            取消
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {hiddenNotice && analysisAllowed && (
                <Notice kind="warn">
                  録画中に別の画面に切り替えた時間がありました。その間の表情は計測されていません(録画は続いています)。
                </Notice>
              )}
              {warning && <Notice kind="error">{warning}</Notice>}
              <button className="danger big stop-btn" onClick={() => void confirmStop()}>
                録画を終了
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckItem({ label, ok, text }: { label: string; ok: boolean | null; text: string }) {
  return (
    <li className={`check-item ${ok === true ? "pass" : ok === false ? "fail" : "wait"}`}>
      <span className="mark">{ok === true ? "●" : ok === false ? "×" : "○"}</span>
      <span className="name">{label}</span>
      <span className="text">{text}</span>
    </li>
  );
}

function sampleLuma(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  box: { x0: number; y0: number; x1: number; y1: number } | null,
): number | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  const b = box ?? { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 };
  const x0 = Math.max(0, Math.floor(b.x0 * canvas.width));
  const x1 = Math.min(canvas.width, Math.ceil(b.x1 * canvas.width));
  const y0 = Math.max(0, Math.floor(b.y0 * canvas.height));
  const y1 = Math.min(canvas.height, Math.ceil(b.y1 * canvas.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return sum / (data.length / 4);
}
