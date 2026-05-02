"use client";
import { useEffect, useState } from "react";
import type { PageDirectedPanel } from "~/types/panels";
import { getEffect } from "./registry";
import type { EffectProps } from "./types";

interface Props {
  panel: PageDirectedPanel | null;
  active: boolean;
  /** ms — total time this panel will be displayed before auto-advance. Optional. */
  durationMs?: number;
  reducedMotion: boolean;
}

/**
 * Renders the active panel's effect_tags as a stacked layer over the page.
 *
 * Performance budget: only the active panel mounts effects. When the
 * active panel changes the previous one's effects unmount, freeing GPU
 * (matches spec 03 budget).
 */
export function PanelEffectsOverlay({
  panel,
  active,
  durationMs,
  reducedMotion,
}: Props) {
  const [progress, setProgress] = useState(0);

  // Drive `progress` 0→1 across the panel's display window when active.
  // Resets whenever the panel changes (key on panel.id below remounts).
  useEffect(() => {
    if (!active || !panel || !durationMs || reducedMotion) {
      setProgress(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      const p = Math.min(1, elapsed / durationMs);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, panel, durationMs, reducedMotion]);

  if (!panel || !active || panel.effectTags.length === 0) return null;

  return (
    <div
      key={panel.id}
      aria-hidden
      className="pointer-events-none absolute inset-0"
    >
      {panel.effectTags.map((tag, i) => {
        const Comp = getEffect(tag);
        if (!Comp) return null;
        const props: EffectProps = {
          bbox: panel.boundingBox,
          active,
          progress,
          reducedMotion,
          position: panel.effectPositions?.[tag] ?? undefined,
        };
        return <Comp key={`${tag}-${i}`} {...props} />;
      })}
    </div>
  );
}
