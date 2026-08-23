// タイムライン(§2 [5] / §7-5)。録画スクラブと各シグナルの時系列を突き合わせる。
// 系列は一度だけ静的に描き、プレイヘッドだけ rAF で動かす。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayFile } from "../engine/sessionStore";
import { formatClock } from "./format";

type TimelineProps = {
  replay: ReplayFile;
  videoUrl: string | null;
};

const LANES = {
  header: { y: 0, h: 16 },
  axes: { y: 16, h: 62 },
  rms: { y: 78, h: 40 },
  face: { y: 118, h: 40 },
  pitch: { y: 158, h: 34 },
} as const;

const CANVAS_H = 192;

export function Timeline({ replay, videoUrl }: TimelineProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seriesRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLCanvasElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const simRef = useRef({ baseMs: 0, wallStart: 0 });
  const simPosRef = useRef(0);

  const durationMs = useMemo(() => {
    const qs = replay.questionsReplay;
    return qs.length > 0 ? qs[qs.length - 1].endAtMs : 0;
  }, [replay]);

  const currentMs = useCallback((): number => {
    const video = videoRef.current;
    // duration 補正ハック中に currentTime が巨大値になることがあるためクランプする
    if (videoUrl && video) return Math.min(video.currentTime * 1000, durationMs);
    if (playingRef.current) {
      const t = simRef.current.baseMs + (performance.now() - simRef.current.wallStart);
      simPosRef.current = Math.min(t, durationMs);
      if (t >= durationMs) {
        playingRef.current = false;
        setPlaying(false);
      }
    }
    return simPosRef.current;
  }, [videoUrl, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(durationMs, ms));
      const video = videoRef.current;
      if (videoUrl && video) {
        video.currentTime = clamped / 1000;
      } else {
        simPosRef.current = clamped;
        simRef.current = { baseMs: clamped, wallStart: performance.now() };
      }
    },
    [videoUrl, durationMs],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (videoUrl && video) {
      if (video.paused) void video.play();
      else video.pause();
      return;
    }
    const next = !playingRef.current;
    playingRef.current = next;
    setPlaying(next);
    if (next) {
      if (simPosRef.current >= durationMs) simPosRef.current = 0;
      simRef.current = { baseMs: simPosRef.current, wallStart: performance.now() };
    }
  }, [videoUrl, durationMs]);

  // MediaRecorder 由来の webm は duration が Infinity になるので補正する
  const fixDuration = useCallback(() => {
    const video = videoRef.current;
    if (!video || Number.isFinite(video.duration)) return;
    let done = false;
    const reset = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", reset);
      video.currentTime = 0;
    };
    video.addEventListener("seeked", reset);
    video.currentTime = 1e7;
    // seeked が来ない実装でも先頭に戻す
    setTimeout(reset, 1_500);
  }, []);

  // 系列の静的描画
  useEffect(() => {
    const draw = () => {
      const canvas = seriesRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      if (w === 0) return;
      canvas.width = w * dpr;
      canvas.height = CANVAS_H * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSeries(ctx, w, replay, durationMs);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [replay, durationMs]);

  // プレイヘッド
  useEffect(() => {
    let raf = 0;
    let lastLabel = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const canvas = playheadRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      if (w === 0) return;
      if (canvas.width !== w * dpr || canvas.height !== CANVAS_H * dpr) {
        canvas.width = w * dpr;
        canvas.height = CANVAS_H * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, CANVAS_H);
      const t = currentMs();
      const x = durationMs > 0 ? (t / durationMs) * w : 0;
      ctx.strokeStyle = "rgba(232, 230, 225, 0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, CANVAS_H);
      ctx.stroke();

      if (now - lastLabel > 166 && timeLabelRef.current) {
        lastLabel = now;
        timeLabelRef.current.textContent = `${formatClock(t)} / ${formatClock(durationMs)}`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [currentMs, durationMs]);

  // クリック/ドラッグでシーク
  const onPointer = useCallback(
    (e: React.PointerEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      seek(frac * durationMs);
    },
    [seek, durationMs],
  );

  return (
    <div className="panel timeline">
      <div className="panel-title">タイムライン — 録画スクラブとシグナル時系列</div>
      <div className={`timeline-body ${videoUrl ? "" : "novideo"}`}>
        {videoUrl && (
          <div>
            <video
              ref={videoRef}
              src={videoUrl}
              className="mirror"
              onLoadedMetadata={fixDuration}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          </div>
        )}
        <div className="strips">
          <div
            ref={wrapRef}
            style={{ position: "relative", cursor: "crosshair" }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              onPointer(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons > 0) onPointer(e);
            }}
          >
            <canvas ref={seriesRef} style={{ height: CANVAS_H }} />
            <canvas
              ref={playheadRef}
              style={{ position: "absolute", inset: 0, height: CANVAS_H, width: "100%" }}
            />
          </div>
          <div className="controls">
            <button className="quiet" onClick={togglePlay}>
              {playing ? "一時停止" : "再生"}
            </button>
            <span className="t num" ref={timeLabelRef}>
              0:00 / {formatClock(durationMs)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 系列描画

function drawSeries(
  ctx: CanvasRenderingContext2D,
  w: number,
  replay: ReplayFile,
  durationMs: number,
): void {
  ctx.fillStyle = "#1c2027";
  ctx.fillRect(0, 0, w, CANVAS_H);
  if (durationMs <= 0) return;
  const X = (t: number) => (t / durationMs) * w;

  // レーン区切りとラベル
  ctx.strokeStyle = "#2a3038";
  ctx.lineWidth = 1;
  ctx.font = "8px 'JetBrains Mono', monospace";
  const laneDefs: { name: string; y: number; h: number }[] = [
    { name: "A / E", ...LANES.axes },
    { name: "RMS", ...LANES.rms },
    { name: "SMILE / BROW", ...LANES.face },
    { name: "PITCH", ...LANES.pitch },
  ];
  for (const lane of laneDefs) {
    ctx.beginPath();
    ctx.moveTo(0, lane.y + 0.5);
    ctx.lineTo(w, lane.y + 0.5);
    ctx.stroke();
    ctx.fillStyle = "#565c66";
    ctx.fillText(lane.name, 4, lane.y + 10);
  }

  // 設問境界
  for (let i = 0; i < replay.questionsReplay.length; i++) {
    const q = replay.questionsReplay[i];
    ctx.strokeStyle = "rgba(138, 144, 153, 0.3)";
    ctx.beginPath();
    ctx.moveTo(X(q.shownAtMs) + 0.5, 0);
    ctx.lineTo(X(q.shownAtMs) + 0.5, CANVAS_H);
    ctx.stroke();
    ctx.fillStyle = "#8a9099";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText(`Q${i + 1}`, X(q.shownAtMs) + 4, 11);
  }

  // A/E ライブ軸値
  {
    const { y, h } = LANES.axes;
    const lv = replay.live;
    const plot = (values: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < lv.t.length; i++) {
        const px = X(lv.t[i]);
        const py = y + h - (values[i] / 100) * (h - 6) - 3;
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    };
    plot(lv.a, "#e8a33d");
    plot(lv.e, "#4fb3a5");
  }

  // 設問ごとの series
  for (const q of replay.questionsReplay) {
    const s = q.series;
    // RMS(発話区間は明るく)
    {
      const { y, h } = LANES.rms;
      for (let i = 0; i < s.t.length; i++) {
        const amp = Math.min(1, s.rms[i] / 0.14) * (h - 8);
        ctx.fillStyle = s.voiced[i] === 1 ? "rgba(232, 230, 225, 0.6)" : "rgba(138, 144, 153, 0.22)";
        ctx.fillRect(X(s.t[i]), y + h - 4 - amp, 1.2, Math.max(1, amp));
      }
    }
    // 笑顔・眉
    {
      const { y, h } = LANES.face;
      const plot = (values: number[], color: string, scale: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < s.t.length; i++) {
          const px = X(s.t[i]);
          const py = y + h - 4 - Math.min(1, values[i] / scale) * (h - 10);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      };
      plot(s.smile, "#4fb3a5", 0.8);
      plot(s.brow, "rgba(138, 144, 153, 0.7)", 0.8);
    }
    // 頭部 pitch(±12°)
    {
      const { y, h } = LANES.pitch;
      ctx.strokeStyle = "rgba(232, 230, 225, 0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < s.t.length; i++) {
        const px = X(s.t[i]);
        const frac = Math.max(-1, Math.min(1, s.pitch[i] / 12));
        const py = y + h / 2 - frac * (h / 2 - 5);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
}
