"use client";

import type { ISourceOptions } from "@tsparticles/engine";
import { ParticleEffect } from "./ParticleEffect";
import type { EffectProps } from "./types";

/**
 * Six particle effect components keyed to the EFFECT_TAGS enum.
 *
 * Each one composes a tsParticles options object tuned for the effect's
 * vibe and hands it to the shared <ParticleEffect>. Reduced-motion
 * collapses each to a static frame (single drawn frame, no movement).
 */

function makeStill(options: ISourceOptions): ISourceOptions {
  return {
    ...options,
    particles: {
      ...options.particles,
      move: { ...(options.particles?.move ?? {}), enable: false },
      life: { ...(options.particles?.life ?? {}), duration: { value: 0 } },
    },
    autoPlay: false,
  };
}

const baseOptions: ISourceOptions = {
  fullScreen: { enable: false },
  background: { color: { value: "transparent" } },
  detectRetina: true,
  fpsLimit: 60,
  // Don't pause when the canvas isn't fully in viewport — preview cards
  // and reader panels are often partly clipped, and we want them
  // animating regardless. The active-panel-only mount in
  // PanelEffectsOverlay already handles the perf budget.
  pauseOnBlur: false,
  pauseOnOutsideViewport: false,
};

// ─── Smoke ─────────────────────────────────────────────────────────────────

const smokeDriftOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    color: { value: ["#9ca3af", "#6b7280", "#4b5563"] },
    opacity: {
      value: { min: 0.0, max: 0.4 },
      animation: {
        enable: true,
        speed: 0.5,
        startValue: "max",
        destroy: "min",
        sync: false,
      },
    },
    size: {
      value: { min: 16, max: 36 },
      animation: { enable: true, speed: 4, startValue: "min", sync: false },
    },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 1.5, max: 3.0 },
      outModes: { default: "destroy" },
      drift: { min: -0.6, max: 0.6 },
    },
    shape: { type: "circle" },
    life: { duration: { value: { min: 4, max: 7 }, sync: false } },
  },
  emitters: {
    position: { x: 50, y: 100 },
    rate: { delay: 0.4, quantity: 1 },
    size: { width: 100, height: 0 },
  },
};

export function SmokeDrift({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`smoke-drift-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={reducedMotion ? makeStill(smokeDriftOptions) : smokeDriftOptions}
    />
  );
}

const smokeBillowOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    color: { value: ["#e5e7eb", "#9ca3af", "#6b7280"] },
    opacity: {
      value: { min: 0.0, max: 0.6 },
      animation: {
        enable: true,
        speed: 0.5,
        startValue: "max",
        destroy: "min",
        sync: false,
      },
    },
    size: {
      value: { min: 30, max: 70 },
      animation: { enable: true, speed: 12, startValue: "min", sync: false },
    },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 1.5, max: 3.0 },
      outModes: { default: "destroy" },
      drift: { min: -0.5, max: 0.5 },
    },
    shape: { type: "circle" },
    life: { duration: { value: { min: 4, max: 6 }, sync: false } },
  },
  emitters: {
    position: { x: 50, y: 95 },
    rate: { delay: 0.4, quantity: 2 },
    size: { width: 80, height: 0 },
  },
};

export function SmokeBillow({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`smoke-billow-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(smokeBillowOptions) : smokeBillowOptions
      }
    />
  );
}

// ─── Fire / embers ─────────────────────────────────────────────────────────

// Fire = many small flecks rising fast from a narrow base, layered with
// additive (screen) blend so overlapping particles brighten into a hot
// core. Sizes shrink as particles age via size animation; opacity fades
// to zero on death so we don't see hard edges popping out.
// Fire: many small flecks emitted from a narrow base, tapering as they
// rise. Each fleck shrinks AND fades out via animations so the top of
// the flame fades into nothing. `mix-blend-mode: screen` on the canvas
// makes overlapping flecks brighten toward the hot yellow core.
const fireFlickerOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    color: { value: ["#fde68a", "#fbbf24", "#f97316", "#dc2626"] },
    opacity: {
      value: { min: 0, max: 0.85 },
      animation: {
        enable: true,
        speed: 1.5,
        startValue: "max",
        destroy: "min",
        sync: false,
      },
    },
    size: {
      value: { min: 3, max: 9 },
      animation: {
        enable: true,
        speed: 6,
        startValue: "max",
        destroy: "min",
        sync: false,
      },
    },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 2.5, max: 5 },
      outModes: { default: "destroy" },
      drift: { min: -0.4, max: 0.4 },
    },
    shape: { type: "circle" },
    life: { duration: { value: { min: 1.2, max: 1.8 }, sync: false } },
  },
  emitters: {
    position: { x: 50, y: 96 },
    rate: { delay: 0.03, quantity: 3 },
    size: { width: 12, height: 0 },
  },
};

export function FireFlicker({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`fire-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(fireFlickerOptions) : fireFlickerOptions
      }
    />
  );
}

const embersRisingOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 35 },
    color: { value: ["#fbbf24", "#f97316", "#fde68a"] },
    opacity: {
      value: { min: 0.6, max: 1.0 },
      animation: { enable: true, speed: 1.5, startValue: "max", count: 1 },
    },
    size: { value: { min: 1, max: 3 } },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 0.8, max: 1.8 },
      outModes: { default: "destroy" },
      drift: { min: -0.8, max: 0.8 },
    },
    shape: { type: "circle" },
    life: { duration: { value: { min: 1.5, max: 3 } } },
  },
  emitters: {
    position: { x: 50, y: 100 },
    rate: { delay: 0.1, quantity: 2 },
    size: { width: 70, height: 0 },
  },
};

export function EmbersRising({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`embers-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(embersRisingOptions) : embersRisingOptions
      }
    />
  );
}

// ─── Weather ───────────────────────────────────────────────────────────────

const rainFallingOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 80 },
    color: { value: ["#bfdbfe", "#93c5fd"] },
    opacity: { value: { min: 0.4, max: 0.7 } },
    size: { value: { min: 1, max: 2 } },
    shape: { type: "line" },
    move: {
      enable: true,
      direction: "bottom",
      angle: { value: 8, offset: 0 },
      speed: { min: 12, max: 20 },
      straight: true,
      outModes: { default: "out" },
    },
    rotate: { value: 8 },
    stroke: { width: 1, color: { value: "#bfdbfe" } },
  },
};

export function RainFalling({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`rain-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(rainFallingOptions) : rainFallingOptions
      }
    />
  );
}

const snowFallingOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 50 },
    color: { value: "#ffffff" },
    opacity: { value: { min: 0.6, max: 1.0 } },
    size: { value: { min: 1, max: 4 } },
    shape: { type: "circle" },
    move: {
      enable: true,
      direction: "bottom",
      speed: { min: 0.8, max: 2.0 },
      drift: { min: -1, max: 1 },
      outModes: { default: "out" },
    },
  },
};

export function SnowFalling({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`snow-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(snowFallingOptions) : snowFallingOptions
      }
    />
  );
}

// Leaf shape — simple SVG so we don't depend on bundled assets. Two
// data URIs (one warm autumn leaf, one cool fall leaf) get rotated
// randomly for variety.
const LEAF_SVG_AUTUMN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#d97706" d="M12 2c-3 4-7 5-7 11s3 9 7 9 7-3 7-9-4-7-7-11z" stroke="#7c2d12" stroke-width="0.6"/><path d="M12 4c0 6 0 12 0 18" stroke="#7c2d12" stroke-width="0.5" fill="none"/></svg>',
  );
const LEAF_SVG_RUST =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#b45309" d="M12 2c-3 4-7 5-7 11s3 9 7 9 7-3 7-9-4-7-7-11z" stroke="#78350f" stroke-width="0.6"/><path d="M12 4c0 6 0 12 0 18" stroke="#78350f" stroke-width="0.5" fill="none"/></svg>',
  );

const leavesDriftingOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 18 },
    opacity: { value: { min: 0.7, max: 1 } },
    size: { value: { min: 8, max: 16 } },
    // Image leaves with a couple of color variants. tsparticles picks
    // randomly per particle. Keeps file size negligible (inline SVG).
    shape: {
      type: "image",
      options: {
        image: [
          { src: LEAF_SVG_AUTUMN, width: 24, height: 24 },
          { src: LEAF_SVG_RUST, width: 24, height: 24 },
        ],
      },
    },
    move: {
      enable: true,
      direction: "bottom",
      speed: { min: 0.6, max: 1.6 },
      outModes: { default: "out" },
    },
    // Wobble lives at the particle level (not move) — sin-wave lateral
    // sway that simulates leaves fluttering as they fall.
    wobble: {
      enable: true,
      distance: 14,
      speed: { min: 4, max: 8 },
    },
    rotate: {
      value: { min: 0, max: 360 },
      animation: { enable: true, speed: 6, sync: false },
    },
    tilt: {
      enable: true,
      direction: "random",
      animation: { enable: true, speed: 8 },
    },
  },
};

export function LeavesDrifting({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`leaves-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      options={
        reducedMotion ? makeStill(leavesDriftingOptions) : leavesDriftingOptions
      }
    />
  );
}
