"use client";
import type { EffectProps } from "./types";
import { resolveEffectRect } from "./types";

const RAYS = Array.from({ length: 18 }, (_, i) => i);

export function ImpactLinesRadial({
  bbox,
  active,
  progress,
  reducedMotion,
  position,
}: EffectProps) {
  if (!active) return null;
  const rect = resolveEffectRect(bbox, position);
  const fade = reducedMotion
    ? 1
    : Math.max(0, 1 - Math.max(0, progress - 0.4) / 0.6);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        ...rect,
        opacity: fade,
        mixBlendMode: "screen",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="-50 -50 100 100"
        preserveAspectRatio="none"
      >
        {RAYS.map((i) => {
          const angle = (i / RAYS.length) * 360;
          return (
            <line
              key={i}
              x1="0"
              y1="0"
              x2="0"
              y2="-50"
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={1.2}
              transform={`rotate(${angle})`}
              strokeLinecap="round"
              strokeDasharray="20 8"
              className={
                reducedMotion
                  ? ""
                  : "animate-[impactRayDash_900ms_ease-out_infinite]"
              }
              style={{ animationDelay: `${(i % 6) * 60}ms` }}
            />
          );
        })}
      </svg>
    </div>
  );
}
