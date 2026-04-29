"use client";
import type { EffectProps } from "./types";

interface Props extends EffectProps {
  variant: "horizontal" | "diagonal";
}

const LINES = Array.from({ length: 14 }, (_, i) => i);

function Lines({ bbox, active, reducedMotion, variant }: Props) {
  if (!active) return null;
  const { x, y, w, h } = bbox;
  const rotate = variant === "diagonal" ? -25 : 0;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
        transform: `rotate(${rotate}deg)`,
        transformOrigin: "50% 50%",
        mixBlendMode: "screen",
      }}
    >
      {LINES.map((i) => {
        const top = (i / LINES.length) * 100;
        const widthPct = 30 + Math.random() * 50;
        const delay = (i % 5) * 80;
        return (
          <div
            key={i}
            className={
              reducedMotion
                ? ""
                : "animate-[speedLineDash_1200ms_linear_infinite]"
            }
            style={{
              position: "absolute",
              top: `${top}%`,
              left: 0,
              width: `${widthPct}%`,
              height: "2px",
              background:
                "linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 60%, rgba(255,255,255,0) 100%)",
              animationDelay: `${delay}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

export function SpeedLinesHorizontal(p: EffectProps) {
  return <Lines {...p} variant="horizontal" />;
}
export function SpeedLinesDiagonal(p: EffectProps) {
  return <Lines {...p} variant="diagonal" />;
}
