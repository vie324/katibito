// 映像の上に顔の枠を描く。候補者の枠を強調し、クリックで候補者を選び直せる。
// 映像は object-fit: contain(全体を見せる)で表示する前提。

import { useEffect, useRef } from "react";
import type { AnalyzerStatus } from "./analyzers";

export function FaceOverlay({
  video,
  status,
  onPick,
  mirror = false,
}: {
  video: HTMLVideoElement | null;
  status: AnalyzerStatus | null;
  onPick?: (x: number, y: number) => void;
  mirror?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas || !video) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!status) return;
      const { ox, oy, sw, sh } = contentRect(video, w, h);
      status.boxes.forEach((b, i) => {
        const x0 = mirror ? 1 - b.x1 : b.x0;
        const x = ox + x0 * sw;
        const y = oy + b.y0 * sh;
        const bw = (b.x1 - b.x0) * sw;
        const bh = (b.y1 - b.y0) * sh;
        const isCand = i === status.candidate;
        ctx.lineWidth = isCand ? 2 : 1;
        ctx.strokeStyle = isCand ? "#4fb3a5" : "rgba(138,144,153,0.8)";
        ctx.setLineDash(isCand ? [] : [4, 4]);
        ctx.strokeRect(x, y, bw, bh);
        ctx.setLineDash([]);
        ctx.font = "12px 'BIZ UDPGothic', sans-serif";
        const label = isCand ? "候補者" : "クリックで候補者に";
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = isCand ? "rgba(79,179,165,0.9)" : "rgba(20,23,28,0.75)";
        ctx.fillRect(x, Math.max(0, y - 18), tw, 18);
        ctx.fillStyle = isCand ? "#0d0f12" : "#e8e6e1";
        ctx.fillText(label, x + 4, Math.max(13, y - 5));
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [video, status, mirror]);

  return (
    <canvas
      ref={canvasRef}
      className="face-overlay"
      style={{ cursor: onPick ? "pointer" : "default" }}
      onClick={(e) => {
        if (!onPick || !video) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const { ox, oy, sw, sh } = contentRect(video, rect.width, rect.height);
        let x = (e.clientX - rect.left - ox) / sw;
        const y = (e.clientY - rect.top - oy) / sh;
        if (mirror) x = 1 - x;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onPick(x, y);
      }}
    />
  );
}

/** object-fit: contain で表示されている映像の、要素内での位置と大きさ */
export function contentRect(video: HTMLVideoElement, w: number, h: number): { ox: number; oy: number; sw: number; sh: number } {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(w / vw, h / vh);
  const sw = vw * scale;
  const sh = vh * scale;
  return { ox: (w - sw) / 2, oy: (h - sh) / 2, sw, sh };
}
