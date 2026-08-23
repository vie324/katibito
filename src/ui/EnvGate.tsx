// 環境チェック(§4)。3秒間サンプリングして5項目を判定する。
// 未達項目には具体的な直し方を出す。「チェックを無視して開始」は常に出す(エスケープハッチ)。

import { useCallback, useEffect, useRef, useState } from "react";
import { MEDIA_CONSTRAINTS } from "../config/flags";
import { GATE } from "../config/scoring";
import { AudioEngine } from "../engine/audioEngine";
import type { FaceEngine } from "../engine/faceEngine";
import type { GateInfo } from "../engine/sessionStore";

type CheckKey = "face" | "size" | "pose" | "light" | "mic";

type CheckState = {
  label: string;
  pass: boolean | null; // null = 計測中
  value: string;
  fix: string | null;
};

type EnvGateProps = {
  faceEngine: FaceEngine | null;
  modelError: string | null;
  existingStream: MediaStream | null;
  existingAudio: AudioEngine | null;
  onMedia: (stream: MediaStream, audio: AudioEngine) => void;
  speechEnabled: boolean;
  speechSupported: boolean;
  onSpeechEnabledChange: (v: boolean) => void;
  onStart: (gate: GateInfo) => void;
  onSample: () => void;
  sampleError: string | null;
};

const INITIAL_CHECKS: Record<CheckKey, CheckState> = {
  face: { label: "顔の検出", pass: null, value: "計測中", fix: null },
  size: { label: "顔の大きさ", pass: null, value: "計測中", fix: null },
  pose: { label: "正対", pass: null, value: "計測中", fix: null },
  light: { label: "明るさ", pass: null, value: "計測中", fix: null },
  mic: { label: "マイク", pass: null, value: "発話待ち", fix: "マイクに向かってひとこと話してください" },
};

export function EnvGate({
  faceEngine,
  modelError,
  existingStream,
  existingAudio,
  onMedia,
  speechEnabled,
  speechSupported,
  onSpeechEnabledChange,
  onStart,
  onSample,
  sampleError,
}: EnvGateProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(existingStream);
  const audioRef = useRef<AudioEngine | null>(existingAudio);
  const micStatsRef = useRef({ maxRms: 0, clippedAt: -1e9, quiet: 0.004 });

  const [mediaState, setMediaState] = useState<"requesting" | "ok" | "denied">(
    existingStream ? "ok" : "requesting",
  );
  const [checks, setChecks] = useState(INITIAL_CHECKS);
  const [retryKey, setRetryKey] = useState(0);

  const allPass = (Object.keys(checks) as CheckKey[]).every((k) => checks[k].pass === true);
  const liveReady = mediaState === "ok" && faceEngine !== null;

  // カメラ・マイクの取得
  useEffect(() => {
    if (streamRef.current && audioRef.current) {
      setMediaState("ok");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const audio = await AudioEngine.create(stream);
        streamRef.current = stream;
        audioRef.current = audio;
        onMedia(stream, audio);
        setMediaState("ok");
      } catch (e) {
        console.warn("[gate] カメラ・マイクを取得できません", e);
        if (!cancelled) setMediaState("denied");
      }
    })();
    return () => {
      cancelled = true;
    };
    // retryKey で再試行できるようにする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey]);

  // プレビュー表示
  useEffect(() => {
    const video = videoRef.current;
    if (mediaState !== "ok" || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [mediaState]);

  // サンプリングループ(§4: 直近3秒)
  useEffect(() => {
    if (!liveReady || !faceEngine) return;
    type Sample = { t: number; detected: boolean; boxH: number; yaw: number; pitch: number };
    const samples: Sample[] = [];
    let lastBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let luma = -1;
    let lastLumaAt = 0;
    const off = document.createElement("canvas");
    off.width = 64;
    off.height = 36;

    const id = setInterval(() => {
      const now = performance.now();
      const video = videoRef.current;
      const audio = audioRef.current;
      if (!video || !audio) return;

      const frame = faceEngine.detect(video);
      if (frame) {
        samples.push({
          t: now,
          detected: frame.detected,
          boxH: frame.box.h,
          yaw: frame.yaw,
          pitch: frame.pitch,
        });
        if (frame.detected) lastBox = { ...frame.box };
      }
      while (samples.length > 0 && samples[0].t < now - GATE.SAMPLE_SECONDS * 1000) {
        samples.shift();
      }

      const at = audio.tick(now);
      const mic = micStatsRef.current;
      if (at.voiced && at.rms > mic.maxRms) mic.maxRms = at.rms;
      if (at.peak > GATE.MIC_CLIP_PEAK) mic.clippedAt = now;
      if (!at.voiced) mic.quiet = mic.quiet * 0.95 + at.rms * 0.05;

      if (now - lastLumaAt > 500 && video.readyState >= 2) {
        lastLumaAt = now;
        luma = sampleLuma(off, video, lastBox);
      }

      setChecks(evaluate(samples, luma, mic, now));
    }, 150);

    return () => clearInterval(id);
  }, [liveReady, faceEngine]);

  const start = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // 静かな区間の観測値でノイズフロアを初期化(VADの精度に効く)
    audio.calibrateNoiseFloor(Math.max(micStatsRef.current.quiet, 0.001));
    const results: Record<string, boolean> = {};
    for (const k of Object.keys(checks) as CheckKey[]) results[k] = checks[k].pass === true;
    onStart({
      passed: allPass,
      skipped: !allPass,
      results,
      speechRecognitionUsed: speechEnabled && speechSupported,
    });
  }, [checks, allPass, onStart, speechEnabled, speechSupported]);

  return (
    <div className="gate-grid">
      <div>
        <div className="gate-video-wrap">
          {mediaState === "ok" ? (
            <video ref={videoRef} className="mirror" muted playsInline autoPlay />
          ) : (
            <div className="sample-placeholder">
              {mediaState === "requesting" ? (
                <div>カメラとマイクの許可を待っています</div>
              ) : (
                <>
                  <div>カメラを使用できません</div>
                  <div style={{ fontSize: 12 }}>
                    アドレスバーのカメラアイコンから許可して、再試行してください
                  </div>
                  <button onClick={() => setRetryKey((k) => k + 1)}>再試行</button>
                </>
              )}
            </div>
          )}
        </div>
        {modelError && (
          <div className="gate-note">
            顔ランドマークモデルを読み込めませんでした({modelError})。
            ライブ計測は使えません。サンプル再生で内容を確認できます。
          </div>
        )}
        <div className="gate-note">
          映像と表情・音響の解析はすべてこの端末内で行われます。文字起こしをオンにした場合のみ、
          音声が Google の音声認識サービスに送信されます。
        </div>
      </div>

      <div>
        <div className="panel">
          <div className="panel-title">環境チェック — 5項目</div>
          <div className="gate-checks">
            {(Object.keys(checks) as CheckKey[]).map((key) => {
              const c = checks[key];
              const cls = c.pass === true ? "pass" : c.pass === false ? "fail" : "wait";
              return (
                <div key={key} className={`gate-check ${cls}`}>
                  <span className="mark">{c.pass === true ? "●" : c.pass === false ? "×" : "○"}</span>
                  <span className="name">{c.label}</span>
                  <span style={{ flex: 1 }}>
                    <div className="value num">{c.value}</div>
                    {c.pass !== true && c.fix && <div className="fix">{c.fix}</div>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <label className="speech-toggle">
          <input
            type="checkbox"
            checked={speechEnabled && speechSupported}
            disabled={!speechSupported}
            onChange={(e) => onSpeechEnabledChange(e.target.checked)}
          />
          <span>
            文字起こしに Chrome の音声認識を使用する(音声が Google に送信されます)。
            オフの場合は表情と音響のみで計測し、言語系の指標は無効になります。
            {!speechSupported && " — この環境では音声認識を使えません。"}
          </span>
        </label>

        <div className="gate-actions">
          <button className="primary" onClick={start} disabled={!liveReady || !allPass}>
            計測を開始
          </button>
          <button className="quiet" onClick={start} disabled={!liveReady}>
            チェックを無視して開始
          </button>
          <button className="quiet" onClick={onSample}>
            サンプルを再生
          </button>
        </div>
        {!allPass && liveReady && (
          <div className="gate-note">
            チェックを無視して開始した場合、結果の確信度は「低」になります。
          </div>
        )}
        {sampleError && <div className="gate-note" style={{ color: "var(--bad)" }}>{sampleError}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 判定

function evaluate(
  samples: { t: number; detected: boolean; boxH: number; yaw: number; pitch: number }[],
  luma: number,
  mic: { maxRms: number; clippedAt: number; quiet: number },
  now: number,
): Record<CheckKey, CheckState> {
  const out: Record<CheckKey, CheckState> = structuredClone(INITIAL_CHECKS);
  const n = samples.length;

  if (n >= 10) {
    const detected = samples.filter((s) => s.detected);
    const detRate = detected.length / n;
    out.face = {
      label: "顔の検出",
      pass: detRate >= GATE.DETECT_MIN_RATE,
      value: `検出率 ${(detRate * 100).toFixed(0)}%`,
      fix:
        detRate >= GATE.DETECT_MIN_RATE
          ? null
          : "顔全体がフレームに入る位置にカメラを合わせてください",
    };

    if (detected.length >= 5) {
      const hs = detected.map((s) => s.boxH).sort((a, b) => a - b);
      const h = hs[Math.floor(hs.length / 2)];
      const small = h < GATE.FACE_H_MIN;
      const large = h > GATE.FACE_H_MAX;
      out.size = {
        label: "顔の大きさ",
        pass: !small && !large,
        value: `映像高の ${(h * 100).toFixed(0)}%`,
        fix: small
          ? "カメラに近づいてください(顔が画面の1/3ほどになる距離)"
          : large
            ? "少しカメラから離れてください"
            : null,
      };

      const okPose =
        detected.filter(
          (s) => Math.abs(s.yaw) <= GATE.POSE_MAX_DEG && Math.abs(s.pitch) <= GATE.POSE_MAX_DEG,
        ).length / detected.length;
      out.pose = {
        label: "正対",
        pass: okPose >= GATE.POSE_MIN_RATE,
        value: `正面率 ${(okPose * 100).toFixed(0)}%`,
        fix:
          okPose >= GATE.POSE_MIN_RATE
            ? null
            : "カメラを目の高さに置き、正面を向いてください",
      };
    }
  }

  if (luma >= 0) {
    const dark = luma < GATE.LUMA_MIN;
    const bright = luma > GATE.LUMA_MAX;
    out.light = {
      label: "明るさ",
      pass: !dark && !bright,
      value: `顔領域輝度 ${luma.toFixed(0)} / 255`,
      fix: dark
        ? "窓を背にせず、顔の正面に光がくる位置に移動してください"
        : bright
          ? "強い光が顔に直接当たらない位置に調整してください"
          : null,
    };
  }

  const clipped = now - mic.clippedAt < 3000;
  const heard = mic.maxRms >= GATE.MIC_MIN_RMS;
  out.mic = {
    label: "マイク",
    pass: heard && !clipped,
    value: heard ? `発話RMS ${mic.maxRms.toFixed(3)}` : "発話待ち",
    fix: clipped
      ? "マイクの入力レベルを下げてください(音が割れています)"
      : heard
        ? null
        : "マイクに向かってひとこと話してください",
  };

  return out;
}

function sampleLuma(
  off: HTMLCanvasElement,
  video: HTMLVideoElement,
  box: { x0: number; y0: number; x1: number; y1: number } | null,
): number {
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return -1;
  ctx.drawImage(video, 0, 0, off.width, off.height);
  let x0 = 0.35, x1 = 0.65, y0 = 0.2, y1 = 0.8;
  if (box) {
    x0 = box.x0;
    x1 = box.x1;
    y0 = box.y0;
    y1 = box.y1;
  }
  const px0 = Math.max(0, Math.floor(x0 * off.width));
  const px1 = Math.min(off.width, Math.ceil(x1 * off.width));
  const py0 = Math.max(0, Math.floor(y0 * off.height));
  const py1 = Math.min(off.height, Math.ceil(y1 * off.height));
  if (px1 <= px0 || py1 <= py0) return -1;
  const data = ctx.getImageData(px0, py0, px1 - px0, py1 - py0).data;
  let sum = 0;
  const count = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / count;
}
