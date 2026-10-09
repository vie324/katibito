// 行動シグナル解析デモ(/demo)。商談用のデモをそのまま残している。
// 画面遷移(§2): 起動 → 環境チェック → 設問 → 結果。
// カメラ拒否・モデル読み込み失敗はサンプル再生モードに逃がす(§9 落ちない設計)。

import { useEffect, useRef, useState } from "react";
import { FLAGS } from "../config/flags";
import { NORMS_VERSION } from "../config/scoring";
import type { AudioEngine } from "../engine/audioEngine";
import { FaceEngine } from "../engine/faceEngine";
import { loadSampleSession } from "../engine/replay";
import type { GateInfo, ReplayFile } from "../engine/sessionStore";
import { SpeechEngine } from "../engine/speechEngine";
import { BootScreen } from "../ui/BootScreen";
import { EnvGate } from "../ui/EnvGate";
import { LiveRunner, SampleRunner } from "../ui/QuestionRunner";
import { ResultPanel } from "../ui/ResultPanel";
import type { ResultData } from "../ui/types";

type Phase = "boot" | "gate" | "run" | "sample" | "result";

export default function DemoApp() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [boot, setBoot] = useState({ stage: "起動中", fraction: 0 });
  const [modelError, setModelError] = useState<string | null>(null);

  const faceRef = useRef<FaceEngine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);

  const [gate, setGate] = useState<GateInfo | null>(null);
  const [speechEnabled, setSpeechEnabled] = useState(
    FLAGS.ENABLE_SPEECH_RECOGNITION && SpeechEngine.supported(),
  );
  const [result, setResult] = useState<ResultData | null>(null);
  const [sampleFile, setSampleFile] = useState<ReplayFile | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  // モデル・WASM のプリロード(§2 [1])
  useEffect(() => {
    let alive = true;
    FaceEngine.create((stage, fraction) => {
      if (alive) setBoot({ stage, fraction });
    })
      .then((engine) => {
        if (!alive) {
          engine.close();
          return;
        }
        faceRef.current = engine;
        setPhase("gate");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        console.error("[app] モデル読み込み失敗", e);
        setModelError(message);
        setPhase("gate");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const prev = document.title;
    document.title = "行動シグナル解析 — デモ";
    return () => {
      document.title = prev;
    };
  }, []);

  // ルーター配下に入ったので、画面を離れるときにカメラ・マイク・モデルを解放する
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRef.current?.close();
      faceRef.current?.close();
    },
    [],
  );

  const startSample = () => {
    if (sampleFile) {
      setPhase("sample");
      return;
    }
    loadSampleSession()
      .then((file) => {
        setSampleFile(file);
        setSampleError(null);
        setPhase("sample");
      })
      .catch(() => {
        setSampleError("サンプルセッションを読み込めません。public/sample-session.json を確認してください。");
      });
  };

  const handleDone = (r: ResultData) => {
    setResult(r);
    setPhase("result");
  };

  const handleRestart = () => {
    if (result?.videoUrl) URL.revokeObjectURL(result.videoUrl);
    setResult(null);
    setPhase("gate");
  };

  if (phase === "boot") {
    return <BootScreen stage={boot.stage} fraction={boot.fraction} />;
  }

  return (
    <div className="frame">
      <div className="appbar">
        <h1>行動シグナル解析</h1>
        <span className="sub">発話速度・声・表情の動きを測ります</span>
        <span className="spacer" />
        {phase === "sample" || (phase === "result" && result?.mode === "sample") ? (
          <span className="badge">サンプル再生</span>
        ) : null}
        <span className="badge provisional">キャリブレーション前・暫定基準</span>
        <span className="badge num">{NORMS_VERSION}</span>
      </div>

      {phase === "gate" && (
        <EnvGate
          faceEngine={faceRef.current}
          modelError={modelError}
          existingStream={streamRef.current}
          existingAudio={audioRef.current}
          onMedia={(stream, audio) => {
            streamRef.current = stream;
            audioRef.current = audio;
          }}
          speechEnabled={speechEnabled}
          speechSupported={SpeechEngine.supported()}
          onSpeechEnabledChange={setSpeechEnabled}
          onStart={(g) => {
            setGate(g);
            setPhase("run");
          }}
          onSample={startSample}
          sampleError={sampleError}
        />
      )}

      {phase === "run" &&
        gate &&
        faceRef.current &&
        streamRef.current &&
        audioRef.current && (
          <LiveRunner
            faceEngine={faceRef.current}
            audioEngine={audioRef.current}
            stream={streamRef.current}
            speechEnabled={speechEnabled && SpeechEngine.supported()}
            gate={gate}
            onDone={handleDone}
            onAbort={() => setPhase("gate")}
          />
        )}

      {phase === "sample" && sampleFile && (
        <SampleRunner file={sampleFile} onDone={handleDone} onAbort={() => setPhase("gate")} />
      )}

      {phase === "result" && result && <ResultPanel data={result} onRestart={handleRestart} />}
    </div>
  );
}
