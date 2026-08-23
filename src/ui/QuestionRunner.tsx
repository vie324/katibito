// 設問ランナー(§2 [3])。3問 × 各60秒。ライブ収録とサンプル再生の両方を駆動する。
// ホットパス(検出→蓄積→描画)は rAF 直結で React state を通さない(§9)。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { INTERSTITIAL_MS, QUESTIONS } from "../config/questions";
import { LIVE } from "../config/scoring";
import type { AudioEngine } from "../engine/audioEngine";
import type { FaceEngine } from "../engine/faceEngine";
import { ReplayPlayer, scoreFromSession } from "../engine/replay";
import {
  createLiveState,
  SessionRecorder,
  type GateInfo,
  type LiveState,
  type ReplayFile,
} from "../engine/sessionStore";
import { SpeechEngine } from "../engine/speechEngine";
import { AxisMeter } from "./AxisMeter";
import { formatClock } from "./format";
import type { MeshHandle } from "./MeshOverlay";
import { QuadrantTrace } from "./QuadrantTrace";
import { Stage } from "./Stage";
import type { ResultData } from "./types";
import { WaveStrip } from "./WaveStrip";

// ---------------------------------------------------------------- 共通ビュー

type RunViewProps = {
  qNo: number;
  qText: string;
  msLeft: number;
  live: LiveState;
  stageNode: ReactNode;
  getWave: () => Float32Array | null;
  actions: ReactNode;
};

function RunView({ qNo, qText, msLeft, live, stageNode, getWave, actions }: RunViewProps) {
  const [interim, setInterim] = useState("");
  useEffect(() => {
    const id = setInterval(() => setInterim(live.interim), 1000 / LIVE.METER_TEXT_HZ);
    return () => clearInterval(id);
  }, [live]);

  return (
    <>
      <div className="question-head">
        <span className="qno num">
          設問 {qNo}/{QUESTIONS.length}
        </span>
        <span className="qtext">{qText}</span>
        <span className={`clock num ${msLeft <= 10_000 ? "low" : ""}`}>{formatClock(msLeft)}</span>
      </div>
      <div className="run-grid">
        <div>
          {stageNode}
          <div style={{ marginTop: "var(--space-3)" }}>
            <WaveStrip live={live} getWave={getWave} />
          </div>
          <div className="interim-line num">{interim}</div>
        </div>
        <div className="rail">
          <div className="panel">
            <div className="panel-title">
              軸メーター
              <span style={{ marginLeft: "auto" }}>ライブ値 (EMA)</span>
            </div>
            <AxisMeter axis="a" live={live} />
            <AxisMeter axis="e" live={live} />
          </div>
          <div className="panel">
            <div className="panel-title">4象限トレース — 直近30秒</div>
            <QuadrantTrace mode="live" live={live} />
          </div>
          <div className="run-actions">{actions}</div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- ライブ収録

type LiveRunnerProps = {
  faceEngine: FaceEngine;
  audioEngine: AudioEngine;
  stream: MediaStream;
  speechEnabled: boolean;
  gate: GateInfo;
  onDone: (r: ResultData) => void;
  onAbort: () => void;
};

export function LiveRunner({
  faceEngine,
  audioEngine,
  stream,
  speechEnabled,
  gate,
  onDone,
  onAbort,
}: LiveRunnerProps) {
  const t0 = useRef(performance.now());
  const clock = useCallback(() => performance.now() - t0.current, []);

  const recorderRef = useRef<SessionRecorder | null>(null);
  if (recorderRef.current === null) {
    recorderRef.current = new SessionRecorder(gate, speechEnabled, navigator.userAgent);
  }
  const recorder = recorderRef.current;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const meshRef = useRef<MeshHandle | null>(null);
  const speechRef = useRef<SpeechEngine | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const deadlineRef = useRef(0);
  const finishingRef = useRef(false);

  const [qIdx, setQIdx] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [msLeft, setMsLeft] = useState(QUESTIONS[0].durationMs);

  // 録画(タイムライン用。エクスポートには含めない — §8)
  useEffect(() => {
    try {
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(1000);
      mediaRecRef.current = rec;
    } catch (e) {
      console.warn("[runner] 録画を開始できません。タイムラインは系列のみになります", e);
    }
    return () => {
      const rec = mediaRecRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    };
  }, [stream]);

  // 音声認識(オフ・失敗でも計測は継続する — §9)
  useEffect(() => {
    if (!speechEnabled) return;
    const speech = new SpeechEngine(
      {
        onFinal: (text, tMs) => recorder.addFinalSegment(text, tMs),
        onInterim: (text) => recorder.setInterim(text),
        onUnavailable: (reason) => {
          console.warn(`[runner] 音声認識を停止: ${reason}`);
          recorder.setInterim("");
        },
      },
      clock,
    );
    speech.start();
    speechRef.current = speech;
    return () => speech.stop();
  }, [speechEnabled, recorder, clock]);

  // ホットパス: 検出 → 蓄積 → メッシュ描画(§9)
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video) return;
      const now = clock();
      const frame = faceEngine.detect(video);
      if (frame) {
        const at = audioEngine.tick(now);
        recorder.pushFrame(
          now,
          frame.detected,
          frame.detected ? frame.blend : null,
          frame.yaw,
          frame.pitch,
          frame.roll,
          at.rms,
          at.f0,
          at.voiced,
        );
        meshRef.current?.draw(frame, video);
      }
      recorder.liveTick(now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [faceEngine, audioEngine, recorder, clock]);

  // 設問シーケンス: インターバル → 出題
  useEffect(() => {
    setAnswering(false);
    const timer = setTimeout(() => {
      const shownAt = clock();
      recorder.beginQuestion(QUESTIONS[qIdx], shownAt);
      deadlineRef.current = shownAt + QUESTIONS[qIdx].durationMs;
      setMsLeft(QUESTIONS[qIdx].durationMs);
      setAnswering(true);
    }, INTERSTITIAL_MS);
    return () => clearTimeout(timer);
  }, [qIdx, recorder, clock]);

  const finishSession = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    speechRef.current?.stop();

    const emit = (videoUrl: string | null) => {
      const data = recorder.finish();
      onDone({
        session: data.session,
        score: data.score,
        replay: data.replay,
        videoUrl,
        mode: "live",
      });
    };

    const rec = mediaRecRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
        emit(blob.size > 0 ? URL.createObjectURL(blob) : null);
      };
      rec.stop();
    } else {
      emit(null);
    }
  }, [recorder, onDone]);

  const advance = useCallback(() => {
    if (!recorder.questionActive || finishingRef.current) return;
    recorder.endQuestion(clock());
    if (qIdx + 1 < QUESTIONS.length) {
      setQIdx(qIdx + 1);
    } else {
      finishSession();
    }
  }, [recorder, clock, qIdx, finishSession]);

  // カウントダウン(4Hz。ホットパスではないので state でよい)
  useEffect(() => {
    if (!answering) return;
    const id = setInterval(() => {
      const left = deadlineRef.current - clock();
      setMsLeft(Math.max(0, left));
      if (left <= 0) advance();
    }, 250);
    return () => clearInterval(id);
  }, [answering, advance, clock]);

  const q = QUESTIONS[qIdx];
  return (
    <RunView
      qNo={qIdx + 1}
      qText={q.text}
      msLeft={msLeft}
      live={recorder.live}
      getWave={() => audioEngine.waveform}
      stageNode={
        <Stage
          ref={videoRef}
          meshRef={meshRef}
          stream={stream}
          live={recorder.live}
          overlay={
            !answering ? (
              <div className="interstitial">
                <div className="next-no num">Q{qIdx + 1}</div>
                <div>次の設問に進みます</div>
              </div>
            ) : null
          }
        />
      }
      actions={
        <>
          <button className="quiet" onClick={onAbort}>
            中止して最初に戻る
          </button>
          <button onClick={advance} disabled={!answering}>
            {qIdx + 1 < QUESTIONS.length ? "次の設問へ" : "回答を終了する"}
          </button>
        </>
      }
    />
  );
}

// ---------------------------------------------------------------- サンプル再生

type SampleRunnerProps = {
  file: ReplayFile;
  onDone: (r: ResultData) => void;
  onAbort: () => void;
};

export function SampleRunner({ file, onDone, onAbort }: SampleRunnerProps) {
  const liveRef = useRef<LiveState | null>(null);
  if (liveRef.current === null) liveRef.current = createLiveState();
  const live = liveRef.current;

  const playerRef = useRef<ReplayPlayer | null>(null);
  const doneRef = useRef(false);
  const qIdxRef = useRef(0);

  const [qIdx, setQIdx] = useState(0);
  const [msLeft, setMsLeft] = useState(0);
  const [speed, setSpeed] = useState(1);
  qIdxRef.current = qIdx;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone({
      session: file.session,
      score: scoreFromSession(file.session),
      replay: file,
      videoUrl: null,
      mode: "sample",
    });
  }, [file, onDone]);

  useEffect(() => {
    const player = new ReplayPlayer(file, live, {
      onQuestion: (index) => setQIdx(index),
      onFinished: finish,
    });
    playerRef.current = player;
    player.start();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      player.tick();
    };
    raf = requestAnimationFrame(loop);

    const id = setInterval(() => {
      const q = file.questionsReplay[Math.min(qIdxRef.current, file.questionsReplay.length - 1)];
      if (q) setMsLeft(Math.max(0, q.endAtMs - player.currentTimeMs));
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [file, live, finish]);

  const toggleSpeed = () => {
    const next = speed === 1 ? 8 : 1;
    setSpeed(next);
    playerRef.current?.setSpeed(next);
  };

  const q = file.questionsReplay[qIdx];
  return (
    <RunView
      qNo={qIdx + 1}
      qText={q?.text ?? ""}
      msLeft={msLeft}
      live={live}
      getWave={() => null}
      stageNode={<Stage stream={null} live={live} sampleMode />}
      actions={
        <>
          <button className="quiet" onClick={onAbort}>
            最初に戻る
          </button>
          <button className="quiet num" onClick={toggleSpeed}>
            再生速度 ×{speed}
          </button>
          <button onClick={finish}>結果へ進む</button>
        </>
      }
    />
  );
}
