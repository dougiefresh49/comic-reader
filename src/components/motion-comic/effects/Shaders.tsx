"use client";

import { ShaderMount } from "@paper-design/shaders-react";
import type { EffectProps } from "./types";

/**
 * WebGL-shader-based replacements for the smoke + fire particle
 * effects. tsParticles renders too literally for these — fragment
 * shaders give us actual flame tongues and volumetric haze.
 *
 * Built on Paper Shaders (paper-design.com), MIT-licensed. The
 * shadcn.io showcase you might've seen is a paywalled wrapper around
 * the same library.
 *
 * Active-panel-only mounting is still enforced upstream by
 * PanelEffectsOverlay, so the GPU cost stays bounded.
 */

interface ShaderShellProps {
  bbox: EffectProps["bbox"];
  active: boolean;
  children: React.ReactNode;
  blendMode?: React.CSSProperties["mixBlendMode"];
}

function ShaderShell({ bbox, active, children, blendMode }: ShaderShellProps) {
  if (!active) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: `${bbox.x * 100}%`,
        top: `${bbox.y * 100}%`,
        width: `${bbox.w * 100}%`,
        height: `${bbox.h * 100}%`,
        overflow: "hidden",
        mixBlendMode: blendMode,
      }}
    >
      {children}
    </div>
  );
}

// Shared GLSL noise + FBM helpers — pasted into each shader's source.
const NOISE_HELPERS = `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p, int octaves) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    v += a * vnoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}
`;

// ─── Fire ──────────────────────────────────────────────────────────────────
//
// Turbulent flame: domain-warped FBM gives the tongue irregular edges
// and lets the tip split/flicker like real fire instead of a uniform
// rocket plume. A wider base + softer top mask keeps the silhouette
// flame-shaped without forcing a perfect cone.

const fireFragmentShader = `#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2 u_resolution;

out vec4 fragColor;

${NOISE_HELPERS}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float h = uv.y; // 0 = base, 1 = tip
  float t = u_time * 0.7;

  // Domain warp: sample one noise field, use it to perturb a second one.
  // This breaks the symmetric cone shape and gives the flame irregular,
  // forking edges that flicker as time advances.
  vec2 q = vec2(uv.x * 1.6 + sin(t * 0.5) * 0.05, h * 1.8 - t * 0.9);
  vec2 warp = vec2(
    fbm(q + vec2(0.0, 0.0), 4),
    fbm(q + vec2(5.2, 1.3), 4)
  );
  float n = fbm(q + warp * 1.4, 5);

  // Vertical taper: the flame is widest at the base, narrows to the tip.
  // Soft x-pinch with height-dependent falloff (less aggressive than a
  // pure cone) so the top of the flame can flicker outward.
  float xCenter = abs(uv.x - 0.5);
  float taper = mix(0.55, 0.15, h); // wider near base
  float pinch = smoothstep(taper, 0.0, xCenter);
  float verticalFade = 1.0 - smoothstep(0.0, 0.95, h);

  float flame = n * pinch * verticalFade;
  // Boost flame density: lower the lower threshold so weaker noise still
  // contributes, and let strong noise pop above 1 for a brighter core.
  flame = smoothstep(0.10, 0.55, flame * 1.2);

  // Color ramp: deep red base → orange → bright yellow core.
  vec3 red = vec3(0.92, 0.10, 0.05);
  vec3 orange = vec3(1.00, 0.45, 0.05);
  vec3 yellow = vec3(1.00, 0.92, 0.45);
  vec3 col = mix(red, orange, smoothstep(0.0, 0.5, flame));
  col = mix(col, yellow, smoothstep(0.55, 0.9, flame));

  // Soft alpha cutoff with extra fade near the tip.
  float alpha = flame * (1.0 - smoothstep(0.85, 1.0, h));

  fragColor = vec4(col * alpha, alpha);
}
`;

export function FireFlickerShader({
  bbox,
  active,
  reducedMotion,
}: EffectProps) {
  return (
    <ShaderShell bbox={bbox} active={active}>
      <ShaderMount
        style={{ width: "100%", height: "100%" }}
        fragmentShader={fireFragmentShader}
        uniforms={{}}
        speed={reducedMotion ? 0 : 1}
      />
    </ShaderShell>
  );
}

// ─── Smoke ─────────────────────────────────────────────────────────────────
//
// Slow drifting wisps: domain-warped FBM with no taper, transparent
// background, gray ramp. Smoke billow uses higher noise frequency +
// stronger warp + brighter color stops so it reads as denser plumes.

function smokeFragmentShader(opts: {
  warpStrength: number;
  baseScale: number;
  speed: number;
  brightness: number;
  contrast: number;
}) {
  return `#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2 u_resolution;

out vec4 fragColor;

${NOISE_HELPERS}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * ${opts.speed.toFixed(3)};

  // Sample at different rates per axis so the smoke reads as drifting
  // upward with subtle horizontal sway. Domain warp gives organic wisps.
  vec2 p = vec2(uv.x * ${opts.baseScale.toFixed(2)}, uv.y * ${opts.baseScale.toFixed(2)} - t * 0.5);
  vec2 warp = vec2(
    fbm(p + vec2(t * 0.2, 0.0), 4),
    fbm(p + vec2(7.3, t * 0.15), 4)
  );
  float n = fbm(p + warp * ${opts.warpStrength.toFixed(2)}, 5);

  // Boost contrast so we get distinct wisps + clear gaps instead of
  // a uniform gray haze. Center around 0.5.
  float v = (n - 0.5) * ${opts.contrast.toFixed(2)} + 0.5 + ${opts.brightness.toFixed(2)};
  v = clamp(v, 0.0, 1.0);

  // Smooth alpha falloff: dark regions = transparent (page shows), bright
  // regions = opaque smoke. Gray color tracks intensity.
  float alpha = smoothstep(0.35, 0.8, v);
  vec3 col = mix(vec3(0.25), vec3(0.85), v);

  fragColor = vec4(col * alpha, alpha);
}
`;
}

const smokeDriftShaderSource = smokeFragmentShader({
  warpStrength: 1.8,
  baseScale: 2.0,
  speed: 0.18,
  brightness: -0.05,
  contrast: 1.7,
});

const smokeBillowShaderSource = smokeFragmentShader({
  warpStrength: 2.5,
  baseScale: 1.4,
  speed: 0.32,
  brightness: 0.05,
  contrast: 1.9,
});

export function SmokeDriftShader({ bbox, active, reducedMotion }: EffectProps) {
  return (
    <ShaderShell bbox={bbox} active={active}>
      <ShaderMount
        style={{ width: "100%", height: "100%" }}
        fragmentShader={smokeDriftShaderSource}
        uniforms={{}}
        speed={reducedMotion ? 0 : 1}
      />
    </ShaderShell>
  );
}

export function SmokeBillowShader({
  bbox,
  active,
  reducedMotion,
}: EffectProps) {
  return (
    <ShaderShell bbox={bbox} active={active}>
      <ShaderMount
        style={{ width: "100%", height: "100%" }}
        fragmentShader={smokeBillowShaderSource}
        uniforms={{}}
        speed={reducedMotion ? 0 : 1}
      />
    </ShaderShell>
  );
}
