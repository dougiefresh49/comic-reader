"use client";

import { useEffect, useRef, useState } from "react";
import { initParticlesEngine } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import { loadEmittersPlugin } from "@tsparticles/plugin-emitters";
import { tsParticles } from "@tsparticles/engine";
import type { Container, ISourceOptions } from "@tsparticles/engine";

let initialized = false;
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (initialized) return Promise.resolve();
  initPromise ??= initParticlesEngine(async (engine) => {
    await loadSlim(engine);
    // Slim doesn't include the emitters plugin; every effect uses
    // emitters to spawn particles continuously, so load it explicitly.
    await loadEmittersPlugin(engine);
  }).then(() => {
    initialized = true;
  });
  return initPromise;
}

interface Props {
  /** Stable unique id — used by tsparticles to track the canvas. */
  id: string;
  /** 0..1 fraction of the page; effect renders inside this rect. */
  bbox: { x: number; y: number; w: number; h: number };
  options: ISourceOptions;
  /** Optional CSS mix-blend-mode for hot/glow effects (e.g. "screen" for fire). */
  blendMode?: "screen" | "lighten" | "plus-lighter";
}

/**
 * Imperative tsParticles wrapper.
 *
 * The official `@tsparticles/react` <Particles> includes the entire
 * props object in its useEffect deps, so any parent re-render destroys
 * and recreates the container. With a 60Hz progress signal driving the
 * preview gallery (and the panel reader), that means particles never
 * accumulate. We side-step the React wrapper and call `tsParticles.load`
 * directly inside a stable useEffect keyed only on `id` and `options`.
 *
 * The bbox styles live on the outer div and re-render at React's
 * normal cadence — that's cheap.
 */
export function ParticleEffect({ id, bbox, options, blendMode }: Props) {
  const [ready, setReady] = useState(initialized);
  const containerRef = useRef<Container | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);

  // First-mount: ensure the engine is loaded.
  useEffect(() => {
    if (!initialized) void ensureInit().then(() => setReady(true));
  }, []);

  // Mount the tsParticles container once when ready, with stable deps.
  // We deliberately omit `bbox` and `blendMode` — they're CSS-only and
  // don't affect the canvas. `options` is module-level and stable.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let local: Container | null = null;
    void tsParticles
      .load({ id, element: targetRef.current ?? undefined, options })
      .then((c) => {
        if (cancelled) {
          c?.destroy();
          return;
        }
        local = c ?? null;
        containerRef.current = local;
      });
    return () => {
      cancelled = true;
      local?.destroy();
      containerRef.current = null;
    };
  }, [ready, id, options]);

  if (!ready) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: `${bbox.x * 100}%`,
        top: `${bbox.y * 100}%`,
        width: `${bbox.w * 100}%`,
        height: `${bbox.h * 100}%`,
        // Constrain the canvas to the bbox so particles don't spill out.
        overflow: "hidden",
        mixBlendMode: blendMode,
      }}
    >
      <div ref={targetRef} id={id} className="h-full w-full" />
    </div>
  );
}
