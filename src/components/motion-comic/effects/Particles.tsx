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
  pauseOnBlur: true,
  pauseOnOutsideViewport: true,
};

// ─── Smoke ─────────────────────────────────────────────────────────────────

const smokeDriftOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 18, density: { enable: true } },
    color: { value: ["#9ca3af", "#6b7280", "#4b5563"] },
    opacity: {
      value: { min: 0.2, max: 0.45 },
      animation: { enable: true, speed: 0.4, sync: false, startValue: "min" },
    },
    size: { value: { min: 30, max: 70 } },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 0.3, max: 0.9 },
      outModes: { default: "destroy", top: "destroy" },
      drift: { min: -0.4, max: 0.4 },
    },
    shape: { type: "circle" },
  },
  emitters: {
    position: { x: 50, y: 100 },
    rate: { delay: 0.3, quantity: 1 },
    size: { width: 80, height: 0 },
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
    number: { value: 12 },
    color: { value: ["#e5e7eb", "#9ca3af", "#6b7280"] },
    opacity: {
      value: { min: 0.0, max: 0.55 },
      animation: { enable: true, speed: 0.6, startValue: "min", count: 1 },
    },
    size: {
      value: { min: 60, max: 130 },
      animation: { enable: true, speed: 8, startValue: "min", count: 1 },
    },
    move: {
      enable: true,
      direction: "top",
      speed: { min: 0.4, max: 1.2 },
      outModes: { default: "destroy" },
      drift: { min: -0.3, max: 0.3 },
    },
    shape: { type: "circle" },
    life: { duration: { value: 5 }, count: 1 },
  },
  emitters: {
    position: { x: 50, y: 90 },
    rate: { delay: 0.5, quantity: 2 },
    size: { width: 60, height: 0 },
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
const fireFlickerOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 0 }, // emitters drive population
    color: { value: ["#fde68a", "#fbbf24", "#f97316", "#dc2626"] },
    opacity: {
      value: { min: 0, max: 0.85 },
      animation: {
        enable: true,
        speed: 2.5,
        startValue: "max",
        destroy: "min",
        sync: false,
      },
    },
    size: {
      value: { min: 2, max: 7 },
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
      speed: { min: 1.5, max: 3.5 },
      outModes: { default: "destroy" },
      gravity: { enable: true, acceleration: -8 }, // accelerate upward
      drift: { min: -0.6, max: 0.6 },
    },
    shape: { type: "circle" },
    life: { duration: { value: { min: 0.4, max: 0.9 }, sync: false } },
    shadow: {
      enable: true,
      blur: 6,
      color: { value: "#fbbf24" },
    },
  },
  emitters: {
    position: { x: 50, y: 100 },
    rate: { delay: 0.02, quantity: 3 },
    size: { width: 18, height: 0 },
  },
};

export function FireFlicker({ bbox, active, reducedMotion }: EffectProps) {
  if (!active) return null;
  return (
    <ParticleEffect
      id={`fire-${Math.round(bbox.x * 1000)}-${Math.round(bbox.y * 1000)}`}
      bbox={bbox}
      blendMode={reducedMotion ? undefined : "screen"}
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

const leavesDriftingOptions: ISourceOptions = {
  ...baseOptions,
  particles: {
    number: { value: 12 },
    color: { value: ["#ca8a04", "#a16207", "#92400e", "#dc2626"] },
    opacity: { value: { min: 0.55, max: 0.9 } },
    size: { value: { min: 4, max: 8 } },
    shape: { type: "polygon", options: { polygon: { sides: 5 } } },
    move: {
      enable: true,
      direction: "bottom",
      speed: { min: 0.5, max: 1.4 },
      drift: { min: -1.5, max: 1.5 },
      outModes: { default: "out" },
    },
    rotate: {
      value: { min: 0, max: 360 },
      animation: { enable: true, speed: 8, sync: false },
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
