// 動画と同期するタイムライン。表情の時系列・質問の区切り・印・メモ・注目シーンを重ねて表示し、
// クリック/ドラッグでその時刻へ移動する。系列は表示範囲が変わったときだけ描き直し、
// 再生位置の線だけを毎フレーム描く。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Highlight } from "../../analysis/expression";
import { reduceSeries, type TimelineSeries } from "../../analysis/series";
import type { Marker, Note } from "../../shared/types";
import { formatClock } from "../format";

type Lane = { key: string; label: string; h: number };

const LANES: Lane[] = [
  { key: "marks", label: "区切り", h: 26 },
  { key: "smile", label: "笑顔", h: 34 },
  { key: "brow", label: "眉", h: 26 },
  { key: "expr", label: "表情の動き", h: 30 },
  { key: "pitch", label: "頭の縦の動き", h: 26 },
  { key: "rms", label: "音量", h: 24 },
  { key: "det", label: "顔の計測", h: 16 },
  { key: "axis", label: "", h: 16 },
];
const LABEL_W = 84;
const HEIGHT = LANES.reduce((s, l) => s + l.h, 0);

const COLORS = {
  bg: "#1c2027",
  rule: "#2a3038",
  label: "#8a9099",
  smile: "#4fb3a5",
  brow: "rgba(79,179,165,0.55)",
  expr: "#e8a33d",
  pitch: "rgba(232,230,225,0.6)",
  rms: "rgba(138,144,153,0.55)",
  detOk: "rgba(111,191,115,0.55)",
  detNg: "rgba(199,91,57,0.75)",
  question: "rgba(232,163,61,0.9)",
  bookmark: "#e8e6e1",
  note: "#4fb3a5",
  playhead: "#e8e6e1",
  highlight: "rgba(79,179,165,0.18)",
};

export type ZoomLevel = "all" | "5m" | "1m";

export function ReviewTimeline({
  series,
  durationMs,
  markers,
  notes,
  highlights,
  getTimeMs,
  onSeek,
}: {
  series: TimelineSeries | null;
  durationMs: number;
  markers: Marker[];
  notes: Note[];
  highlights: Highlight[];
  getTimeMs: () => number;
  onSeek: (ms: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<ZoomLevel>("all");
  const [view, setView] = useState<{ from: number; to: number }>({ from: 0, to: Math.max(1, durationMs) });
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const span = zoom === "all" ? durationMs : zoom === "5m" ? 5 * 60_000 : 60_000;

  // 表示範囲: 拡大時は再生位置に追従する
  useEffect(() => {
    if (zoom === "all") {
      setView({ from: 0, to: Math.max(1, durationMs) });
      return;
    }
    let raf = 0;
    const follow = () => {
      raf = requestAnimationFrame(follow);
      if (dragging.current) return;
      const t = getTimeMs();
      const v = viewRef.current;
      const s = Math.min(span, durationMs);
      if (t < v.from || t > v.to - s * 0.1 || v.to - v.from !== s) {
        const from = Math.max(0, Math.min(durationMs - s, t - s * 0.2));
        setView({ from, to: from + s });
      }
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [zoom, span, durationMs, getTimeMs]);

  // 系列の描画
  useEffect(() => {
    const draw = () => {
      const canvas = baseRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      if (w === 0) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBase(ctx, w, view, series, markers, notes, highlights);
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (baseRef.current) ro.observe(baseRef.current);
    return () => ro.disconnect();
  }, [view, series, markers, notes, highlights]);

  // 再生位置
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const canvas = headRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      if (w === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, HEIGHT);
      const v = viewRef.current;
      const t = getTimeMs();
      if (t < v.from || t > v.to) return;
      const x = LABEL_W + ((t - v.from) / (v.to - v.from)) * (w - LABEL_W);
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getTimeMs]);

  const timeAt = useCallback((clientX: number): number | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    if (x < LABEL_W) return null;
    const v = viewRef.current;
    const frac = (x - LABEL_W) / (rect.width - LABEL_W);
    return Math.max(0, Math.min(durationMs, v.from + frac * (v.to - v.from)));
  }, [durationMs]);

  return (
    <div className="review-timeline">
      <div className="timeline-tools">
        <span className="muted small">拡大</span>
        {(["all", "5m", "1m"] as ZoomLevel[]).map((z) => (
          <button key={z} className={`tab small ${zoom === z ? "active" : ""}`} onClick={() => setZoom(z)}>
            {z === "all" ? "全体" : z === "5m" ? "5分" : "1分"}
          </button>
        ))}
        <span className="spacer" />
        <span className="legend">
          <i style={{ background: COLORS.question }} />質問 <i style={{ background: COLORS.bookmark }} />印
          <i style={{ background: COLORS.note }} />メモ
        </span>
        <span className="num small hover-time">{hover ? formatClock(hover.t) : ""}</span>
      </div>
      <div
        ref={wrapRef}
        className="timeline-canvas"
        style={{ height: HEIGHT }}
        onPointerDown={(e) => {
          const t = timeAt(e.clientX);
          if (t === null) return;
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          onSeek(t);
        }}
        onPointerMove={(e) => {
          const t = timeAt(e.clientX);
          setHover(t === null ? null : { x: e.clientX, t });
          if (dragging.current && t !== null) onSeek(t);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={baseRef} style={{ height: HEIGHT }} />
        <canvas ref={headRef} style={{ height: HEIGHT, position: "absolute", inset: 0, width: "100%", pointerEvents: "none" }} />
      </div>
      {!series && <div className="muted small timeline-note">表情の計測データがないため、区切りだけを表示しています。</div>}
    </div>
  );
}

function drawBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  view: { from: number; to: number },
  series: TimelineSeries | null,
  markers: Marker[],
  notes: Note[],
  highlights: Highlight[],
): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, HEIGHT);
  const plotW = Math.max(10, w - LABEL_W);
  const X = (t: number) => LABEL_W + ((t - view.from) / (view.to - view.from)) * plotW;

  // レーン
  let y = 0;
  const laneY: Record<string, { y: number; h: number }> = {};
  ctx.font = "11px 'BIZ UDPGothic', sans-serif";
  for (const lane of LANES) {
    laneY[lane.key] = { y, h: lane.h };
    ctx.strokeStyle = COLORS.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.label;
    ctx.fillText(lane.label, 6, y + Math.min(lane.h - 4, 15));
    y += lane.h;
  }
  ctx.strokeStyle = COLORS.rule;
  ctx.beginPath();
  ctx.moveTo(LABEL_W + 0.5, 0);
  ctx.lineTo(LABEL_W + 0.5, HEIGHT);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, 0, plotW, HEIGHT);
  ctx.clip();

  // 注目シーン(背景の帯)
  for (const h of highlights) {
    if (h.kind === "gap") continue;
    const x = X(h.tMs);
    ctx.fillStyle = COLORS.highlight;
    ctx.fillRect(x - 3, laneY.smile.y, 6, laneY.expr.y + laneY.expr.h - laneY.smile.y);
  }

  // 区切り
  {
    const { y: ly, h: lh } = laneY.marks;
    const qs = markers.filter((m) => m.kind === "question").sort((a, b) => a.tMs - b.tMs);
    qs.forEach((m, i) => {
      const x = X(m.tMs);
      ctx.strokeStyle = COLORS.question;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, ly);
      ctx.lineTo(x + 0.5, HEIGHT);
      ctx.globalAlpha = 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.question;
      ctx.fillRect(x, ly + 3, 2, lh - 6);
      const next = qs[i + 1] ? X(qs[i + 1].tMs) : LABEL_W + plotW;
      const room = next - x - 8;
      if (room > 24) {
        ctx.fillStyle = "#e8e6e1";
        ctx.font = "11px 'BIZ UDPGothic', sans-serif";
        ctx.fillText(ellipsize(ctx, m.label || `質問${i + 1}`, room), x + 5, ly + 16);
      }
    });
    for (const m of markers) {
      if (m.kind !== "bookmark") continue;
      const x = X(m.tMs);
      ctx.fillStyle = COLORS.bookmark;
      ctx.beginPath();
      ctx.moveTo(x, ly + 4);
      ctx.lineTo(x + 5, ly + 11);
      ctx.lineTo(x - 5, ly + 11);
      ctx.closePath();
      ctx.fill();
    }
    for (const n of notes) {
      if (n.tMs === null) continue;
      const x = X(n.tMs);
      ctx.fillStyle = COLORS.note;
      ctx.beginPath();
      ctx.arc(x, ly + lh - 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (series) {
    const b0 = Math.max(0, Math.floor(view.from / series.binMs));
    const b1 = Math.min(series.count, Math.ceil(view.to / series.binMs));
    const buckets = Math.max(1, Math.min(Math.floor(plotW), b1 - b0));
    const bx = (k: number) => LABEL_W + ((k + 0.5) / buckets) * plotW;
    const bw = plotW / buckets;

    const area = (key: string, values: Float32Array, scale: number, color: string, mode: "max" | "mean") => {
      const { y: ly, h: lh } = laneY[key];
      const red = reduceSeries(values, b0, b1, buckets, mode);
      ctx.fillStyle = color;
      for (let k = 0; k < buckets; k++) {
        const v = red[k];
        if (Number.isNaN(v)) continue;
        const hh = Math.min(1, Math.max(0, v / scale)) * (lh - 6);
        ctx.fillRect(LABEL_W + (k / buckets) * plotW, ly + lh - 3 - hh, Math.max(1, bw - 0.3), Math.max(0.5, hh));
      }
    };
    area("smile", series.smile, 0.8, COLORS.smile, "max");
    area("brow", series.brow, 0.8, COLORS.brow, "max");
    area("expr", series.expr, 2.0, COLORS.expr, "mean");
    area("rms", series.rms, 0.15, COLORS.rms, "mean");

    // 頭の縦の動き(中央値からの差 ±20°)
    {
      const { y: ly, h: lh } = laneY.pitch;
      const red = reduceSeries(series.pitch, b0, b1, buckets, "mean");
      ctx.strokeStyle = COLORS.pitch;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < buckets; k++) {
        const v = red[k];
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const yy = ly + lh / 2 + Math.max(-1, Math.min(1, v / 20)) * (lh / 2 - 3);
        if (!pen) ctx.moveTo(bx(k), yy);
        else ctx.lineTo(bx(k), yy);
        pen = true;
      }
      ctx.stroke();
    }

    // 顔の計測
    {
      const { y: ly, h: lh } = laneY.det;
      const red = reduceSeries(series.detected, b0, b1, buckets, "min");
      for (let k = 0; k < buckets; k++) {
        const v = red[k];
        if (Number.isNaN(v)) continue;
        ctx.fillStyle = v >= 0.5 ? COLORS.detOk : COLORS.detNg;
        ctx.fillRect(LABEL_W + (k / buckets) * plotW, ly + 2, Math.max(1, bw), lh - 4);
      }
    }
  }
  ctx.restore();

  // 時刻の目盛り
  const axis = laneY.axis;
  const span = view.to - view.from;
  const step = span <= 90_000 ? 10_000 : span <= 6 * 60_000 ? 60_000 : span <= 40 * 60_000 ? 5 * 60_000 : 10 * 60_000;
  ctx.fillStyle = COLORS.label;
  ctx.font = "10px 'JetBrains Mono', monospace";
  for (let t = Math.ceil(view.from / step) * step; t <= view.to; t += step) {
    const x = X(t);
    if (x < LABEL_W + 2 || x > w - 30) continue;
    ctx.fillRect(x, axis.y, 1, 4);
    ctx.fillText(formatClock(t), x + 3, axis.y + 12);
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
