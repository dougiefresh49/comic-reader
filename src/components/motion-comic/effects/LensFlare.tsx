"use client";
import type { EffectProps } from "./types";

interface Props extends EffectProps {
  palette: "warm" | "cool";
}

function Flare({ bbox, active, reducedMotion, palette }: Props) {
  if (!active) return null;
  const { x, y, w, h } = bbox;
  const colors =
    palette === "warm"
      ? ["rgba(255, 220, 150, 0.55)", "rgba(255, 160, 80, 0.25)"]
      : ["rgba(180, 220, 255, 0.55)", "rgba(120, 180, 255, 0.25)"];
  // Two stacked radial gradients drift slowly across the panel.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
        mixBlendMode: "screen",
      }}
    >
      <div
        className={
          reducedMotion ? "" : "animate-[flareDrift_8s_ease-in-out_infinite]"
        }
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse 30% 30% at 30% 30%, ${colors[0]} 0%, transparent 60%), radial-gradient(ellipse 18% 18% at 65% 55%, ${colors[1]} 0%, transparent 70%)`,
        }}
      />
    </div>
  );
}

export function LensFlareWarm(p: EffectProps) {
  return <Flare {...p} palette="warm" />;
}
export function LensFlareCool(p: EffectProps) {
  return <Flare {...p} palette="cool" />;
}
