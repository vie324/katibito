// 波形 + F0 ストリップ(§12 Step 2)。Canvas 直描き、React state 不使用(§9)。
// 上段: 現在の波形(ライブ)/ RMS 履歴(サンプル再生)。下段: F0 履歴とVAD。

import { useEffect, useRef } from "react";
import { SIGNAL } from "../config/scoring";
import { FloatRing } from "../engine/ringBuffer";
import type { LiveState } from "../engine/sessionStore";

type WaveStripProps = {
  live: LiveState;
  /** ライブ時は AudioEngine.waveform を返す。サンプル再生時は null */
  getWave: () => Float32Array | null;
};

export function WaveStrip({ live, getWave }: WaveStripProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rmsHist = new FloatRing(480);
    const f0Hist = new FloatRing(480);
    let lastPush = 0;
    let lastText = 0;
    let textRms = "0.000";
    let textF0 = "—";
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0) return;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 履歴 push(≈30Hz)
      if (now - lastPush >= 30) {
        lastPush = now;
        rmsHist.push(live.voiced ? live.rms : -live.rms);
        f0Hist.push(live.f0);
      }
      // 数値表示は 6Hz(§9-2)
      if (now - lastText >= 166) {
        lastText = now;
        textRms = live.rms.toFixed(3);
        textF0 = live.f0 > 0 ? `${Math.round(live.f0)}` : "—";
      }

      ctx.fillStyle = "#1c2027";
      ctx.fillRect(0, 0, w, h);

      const rightW = 96;
      const plotW = w - rightW;
      const topH = Math.round(h * 0.58);

      // 罫線
      ctx.strokeStyle = "#2a3038";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, topH + 0.5);
      ctx.lineTo(plotW, topH + 0.5);
      ctx.moveTo(plotW + 0.5, 0);
      ctx.lineTo(plotW + 0.5, h);
      ctx.stroke();

      // 上段: 波形(ライブ)または RMS 履歴
      const wave = getWave();
      const mid = topH / 2;
      if (wave) {
        ctx.strokeStyle = "rgba(232, 230, 225, 0.75)";
        ctx.beginPath();
        const step = Math.max(1, Math.floor(wave.length / plotW));
        const gain = Math.min(6, 0.42 / Math.max(0.02, live.rms * 3));
        for (let x = 0; x < plotW; x++) {
          const v = wave[Math.min(wave.length - 1, x * step)];
          const y = mid - v * topH * gain;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        // サンプル再生: RMS 履歴を上下対称のエンベロープで描く
        const n = rmsHist.length;
        for (let i = 0; i < n; i++) {
          const v = rmsHist.at(i);
          const voiced = v >= 0;
          const amp = Math.min(1, Math.abs(v) / 0.14) * (topH * 0.44);
          const x = plotW - n + i;
          if (x < 0) continue;
          ctx.fillStyle = voiced ? "rgba(232, 230, 225, 0.7)" : "rgba(138, 144, 153, 0.25)";
          ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
        }
      }

      // 下段: F0 履歴(ティール)
      {
        const laneTop = topH + 2;
        const laneH = h - laneTop - 2;
        const f0min = SIGNAL.F0_MIN_HZ;
        const f0max = 320;
        const n = f0Hist.length;
        ctx.fillStyle = "rgba(79, 179, 165, 0.9)";
        for (let i = 0; i < n; i++) {
          const v = f0Hist.at(i);
          if (v <= 0) continue;
          const x = plotW - n + i;
          if (x < 0) continue;
          const frac = Math.min(1, Math.max(0, (v - f0min) / (f0max - f0min)));
          ctx.fillRect(x, laneTop + (1 - frac) * laneH, 1.5, 1.5);
        }
      }

      // 右: 数値
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#8a9099";
      ctx.fillText("RMS", plotW + 10, 16);
      ctx.fillText("F0 Hz", plotW + 10, topH + 16);
      ctx.font = "15px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#e8e6e1";
      ctx.fillText(textRms, plotW + 10, 36);
      ctx.fillStyle = "#4fb3a5";
      ctx.fillText(textF0, plotW + 10, topH + 36);
      // VADインジケータ
      ctx.fillStyle = live.voiced ? "#6fbf73" : "#2a3038";
      ctx.fillRect(plotW + 10, topH - 14, 8, 8);
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#565c66";
      ctx.fillText("VAD", plotW + 22, topH - 6);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [live, getWave]);

  return (
    <div className="wavestrip">
      <canvas ref={canvasRef} />
    </div>
  );
}
