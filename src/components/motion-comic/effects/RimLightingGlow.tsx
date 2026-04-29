"use client";
import type { EffectProps } from "./types";

export function RimLightingGlow({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  const { x, y, w, h } = bbox;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-sm ${reducedMotion ? "" : "animate-[rimGlowPulse_2400ms_ease-in-out_infinite]"}`}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
        boxShadow:
          "0 0 24px 4px rgba(255, 220, 120, 0.55), inset 0 0 18px 2px rgba(255, 220, 120, 0.35)",
      }}
    />
  );
}
