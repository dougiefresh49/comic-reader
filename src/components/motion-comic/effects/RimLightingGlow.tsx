"use client";
import type { EffectProps } from "./types";
import { resolveEffectRect } from "./types";

export function RimLightingGlow({
  bbox,
  active,
  reducedMotion,
  position,
}: EffectProps) {
  if (!active) return null;
  const rect = resolveEffectRect(bbox, position);
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-sm ${reducedMotion ? "" : "animate-[rimGlowPulse_2400ms_ease-in-out_infinite]"}`}
      style={{
        ...rect,
        boxShadow:
          "0 0 24px 4px rgba(255, 220, 120, 0.55), inset 0 0 18px 2px rgba(255, 220, 120, 0.35)",
      }}
    />
  );
}
