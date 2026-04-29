"use client";

import { useEffect, useState } from "react";
import Particles, { initParticlesEngine } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { ISourceOptions } from "@tsparticles/engine";

let initialized = false;
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (initialized) return Promise.resolve();
  initPromise ??= initParticlesEngine(async (engine) => {
    await loadSlim(engine);
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
}

/**
 * Shared particle wrapper. Lazy-loads the slim engine bundle once on
 * first render and keeps it cached. Each instance positions a canvas
 * over the panel's bbox.
 */
export function ParticleEffect({ id, bbox, options }: Props) {
  const [ready, setReady] = useState(initialized);
  useEffect(() => {
    if (!initialized) void ensureInit().then(() => setReady(true));
  }, []);

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
      }}
    >
      <Particles id={id} options={options} className="h-full w-full" />
    </div>
  );
}
