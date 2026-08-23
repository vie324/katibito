// ★シグネチャ要素(§11): 4象限グリッド上を動く光点と減衰トレイル。
// 直近30秒の軌跡が尾を引き、古いほど薄い。ボールドさはここに全部使う。

import { useEffect, useRef } from "react";
import { QUADRANTS } from "../config/scoring";
import type { LiveState } from "../engine/sessionStore";

type LiveTraceProps = {
  mode: "live";
  live: LiveState;
};

type StaticTraceProps = {
  mode: "static";
  trail: { a: number[]; e: number[] };
  finalA: number | null;
  finalE: number | null;
};

type QuadrantTraceProps = LiveTraceProps | StaticTraceProps;

export function QuadrantTrace(props: QuadrantTraceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const displayPos = { x: NaN, y: NaN };
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const p = propsRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const size = canvas.clientWidth;
      if (size === 0) return;
      if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const s = size;
      const toX = (a: number) => (a / 100) * s;
      const toY = (e: number) => s - (e / 100) * s;

      // 地とグリッド
      ctx.fillStyle = "#14171c";
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "#232830";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const q of [25, 75]) {
        ctx.moveTo(toX(q) + 0.5, 0);
        ctx.lineTo(toX(q) + 0.5, s);
        ctx.moveTo(0, toY(q) + 0.5);
        ctx.lineTo(s, toY(q) + 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = "#2a3038";
      ctx.beginPath();
      ctx.moveTo(toX(50) + 0.5, 0);
      ctx.lineTo(toX(50) + 0.5, s);
      ctx.moveTo(0, toY(50) + 0.5);
      ctx.lineTo(s, toY(50) + 0.5);
      ctx.stroke();
      ctx.strokeStyle = "#2a3038";
      ctx.strokeRect(0.5, 0.5, s - 1, s - 1);

      // 軸ラベル(色 = 軸対応。装飾ではなく情報)
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#e8a33d";
      ctx.textAlign = "right";
      ctx.fillText("主張性 →", s - 8, s - 8);
      ctx.save();
      ctx.translate(14, s / 2 + 40);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#4fb3a5";
      ctx.textAlign = "left";
      ctx.fillText("感情表出性 →", 0, 0);
      ctx.restore();

      // 象限名(四隅、静かに)
      ctx.font = "11px 'BIZ UDPGothic', sans-serif";
      ctx.fillStyle = "#565c66";
      ctx.textAlign = "left";
      ctx.fillText(QUADRANTS.harmonizer.name, 12, 24);
      ctx.textAlign = "right";
      ctx.fillText(QUADRANTS.sender.name, s - 12, 24);
      ctx.textAlign = "left";
      ctx.fillText(QUADRANTS.thinker.name, 12, s - 26);
      ctx.textAlign = "right";
      ctx.fillText(QUADRANTS.decider.name, s - 12, s - 26);
      ctx.textAlign = "left";

      // トレイル
      const drawTrail = (at: (i: number) => { a: number; e: number }, n: number, span: number) => {
        if (n < 2) return;
        for (let i = 1; i < n; i++) {
          const p0 = at(i - 1);
          const p1 = at(i);
          const age = i / (n - 1);
          const alpha = Math.pow(age, span) * 0.55;
          ctx.strokeStyle = `rgba(232, 230, 225, ${alpha.toFixed(3)})`;
          ctx.lineWidth = 1 + age * 1.2;
          ctx.beginPath();
          ctx.moveTo(toX(p0.a), toY(p0.e));
          ctx.lineTo(toX(p1.a), toY(p1.e));
          ctx.stroke();
        }
      };

      let targetA = NaN;
      let targetE = NaN;
      if (p.mode === "live") {
        const { trailA, trailE } = p.live;
        drawTrail((i) => ({ a: trailA.at(i), e: trailE.at(i) }), trailA.length, 1.6);
        targetA = p.live.a;
        targetE = p.live.e;
      } else {
        const { a, e } = p.trail;
        drawTrail((i) => ({ a: a[i], e: e[i] }), a.length, 2.2);
        targetA = p.finalA ?? NaN;
        targetE = p.finalE ?? NaN;
      }

      if (Number.isNaN(targetA) || Number.isNaN(targetE)) return;

      // 光点(なめらかに追従)。端の値でも欠けないよう少し内側にクランプする
      const inset = 7;
      const tx = Math.max(inset, Math.min(s - inset, toX(targetA)));
      const ty = Math.max(inset, Math.min(s - inset, toY(targetE)));
      if (Number.isNaN(displayPos.x)) {
        displayPos.x = tx;
        displayPos.y = ty;
      } else {
        displayPos.x += (tx - displayPos.x) * 0.18;
        displayPos.y += (ty - displayPos.y) * 0.18;
      }
      const pulse = p.mode === "static" ? 0.8 + 0.2 * Math.sin(now / 700) : 1;
      const glowR = 20;
      const g = ctx.createRadialGradient(
        displayPos.x, displayPos.y, 0,
        displayPos.x, displayPos.y, glowR,
      );
      g.addColorStop(0, `rgba(255, 251, 240, ${0.85 * pulse})`);
      g.addColorStop(0.35, `rgba(232, 195, 120, ${0.28 * pulse})`);
      g.addColorStop(1, "rgba(232, 195, 120, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(displayPos.x, displayPos.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fffdf7";
      ctx.beginPath();
      ctx.arc(displayPos.x, displayPos.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="trace-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}
