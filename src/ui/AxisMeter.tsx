// 2軸メーター(§10)。SVG 描画。
// バーは rAF で直接 DOM を更新し、数値テキストは 6Hz(§9-2)。React 再レンダなし。

import { useEffect, useRef } from "react";
import { LIVE } from "../config/scoring";
import type { LiveState } from "../engine/sessionStore";

const W = 300;
const H = 30;
const TRACK_Y = 12;
const TRACK_H = 8;

type AxisMeterProps = {
  axis: "a" | "e";
  live: LiveState;
};

const LABELS = { a: "主張性", e: "感情表出性" } as const;
const COLORS = { a: "var(--signal-a)", e: "var(--signal-e)" } as const;

export function AxisMeter({ axis, live }: AxisMeterProps) {
  const fillRef = useRef<SVGRectElement>(null);
  const needleRef = useRef<SVGRectElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const displayRef = useRef<number>(NaN);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const target = axis === "a" ? live.a : live.e;
      const fill = fillRef.current;
      const needle = needleRef.current;
      if (!fill || !needle) return;
      if (Number.isNaN(target)) {
        fill.setAttribute("width", "0");
        needle.setAttribute("opacity", "0");
        return;
      }
      const cur = displayRef.current;
      const next = Number.isNaN(cur) ? target : cur + (target - cur) * 0.22;
      displayRef.current = next;
      const x = (next / 100) * W;
      fill.setAttribute("width", String(Math.max(0, x)));
      needle.setAttribute("x", String(Math.max(0, Math.min(W - 2, x - 1))));
      needle.setAttribute("opacity", "1");
    };
    raf = requestAnimationFrame(loop);

    const textTimer = setInterval(() => {
      const el = valueRef.current;
      if (!el) return;
      const v = displayRef.current;
      el.textContent = Number.isNaN(v) ? "──" : String(Math.round(v));
    }, 1000 / LIVE.METER_TEXT_HZ);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(textTimer);
    };
  }, [axis, live]);

  const color = COLORS[axis];
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * W;
    const major = i === 5;
    ticks.push(
      <line
        key={i}
        x1={x}
        x2={x}
        y1={major ? 4 : 8}
        y2={TRACK_Y}
        stroke={major ? "var(--ink-dim)" : "var(--rule)"}
        strokeWidth={1}
      />,
    );
  }

  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label" style={{ color }}>
          {LABELS[axis]}
        </span>
        <span className="meter-value num" style={{ color }}>
          <span ref={valueRef}>──</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" height={H}>
        {ticks}
        <rect
          x={0}
          y={TRACK_Y}
          width={W}
          height={TRACK_H}
          fill="var(--panel)"
          stroke="var(--rule)"
          strokeWidth={1}
        />
        <rect ref={fillRef} x={0} y={TRACK_Y} width={0} height={TRACK_H} fill={color} opacity={0.55} />
        <rect ref={needleRef} x={0} y={TRACK_Y - 3} width={2} height={TRACK_H + 6} fill={color} />
      </svg>
    </div>
  );
}
