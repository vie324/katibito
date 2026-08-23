// メッシュオーバーレイ(§9-5)。478点全部は描かず、輪郭・眉・口・目の代表点のみ。
// React state を経由せず、rAF ループから imperative に draw() を呼ぶ。

import { forwardRef, useImperativeHandle, useRef } from "react";
import { FLAGS } from "../config/flags";
import { FACE_CONTOURS, type FaceFrame } from "../engine/faceEngine";

export type MeshHandle = {
  draw: (frame: FaceFrame | null, video: HTMLVideoElement) => void;
  clear: () => void;
};

// 輪郭コネクタから代表点のインデックス集合を作る(約120点)
let contourPoints: number[] | null = null;
function getContourPoints(): number[] {
  if (contourPoints === null) {
    const set = new Set<number>();
    for (const c of FACE_CONTOURS) {
      set.add(c.start);
      set.add(c.end);
    }
    contourPoints = [...set];
  }
  return contourPoints;
}

export const MeshOverlay = forwardRef<MeshHandle>(function MeshOverlay(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    draw(frame, video) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!FLAGS.DRAW_MESH || !frame || !frame.detected || !frame.landmarks) return;

      // object-fit: cover のマッピング
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const scale = Math.max(w / vw, h / vh);
      const ox = (w - vw * scale) / 2;
      const oy = (h - vh * scale) / 2;
      const px = (nx: number) => nx * vw * scale + ox;
      const py = (ny: number) => ny * vh * scale + oy;

      const lm = frame.landmarks;

      ctx.strokeStyle = "rgba(138, 144, 153, 0.32)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of FACE_CONTOURS) {
        const a = lm[c.start];
        const b = lm[c.end];
        if (!a || !b) continue;
        ctx.moveTo(px(a.x), py(a.y));
        ctx.lineTo(px(b.x), py(b.y));
      }
      ctx.stroke();

      ctx.fillStyle = "rgba(232, 230, 225, 0.55)";
      for (const i of getContourPoints()) {
        const p = lm[i];
        if (!p) continue;
        ctx.fillRect(px(p.x) - 0.75, py(p.y) - 0.75, 1.5, 1.5);
      }
    },
    clear() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  }));

  return <canvas className="mesh" ref={canvasRef} />;
});
