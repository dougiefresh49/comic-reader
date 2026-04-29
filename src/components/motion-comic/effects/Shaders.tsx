"use client";

import { ShaderMount, SimplexNoise } from "@paper-design/shaders-react";
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

// ─── Smoke (drift + billow) ────────────────────────────────────────────────
//
// SimplexNoise with grayscale color stops produces volumetric haze that
// drifts upward. `speed` controls flow rate; `softness` controls edge
// blur. Drift is a slower, sparser haze; billow is denser and brighter.

export function SmokeDriftShader({ bbox, active, reducedMotion }: EffectProps) {
  return (
    <ShaderShell bbox={bbox} active={active}>
      <SimplexNoise
        style={{ width: "100%", height: "100%" }}
        // 8-digit hex carries alpha — the dark stops are transparent so the
        // page behind shows through the gaps between wisps.
        colors={[
          "#00000000",
          "#3f3f4633",
          "#6b728088",
          "#9ca3afcc",
          "#d1d5dbee",
        ]}
        stepsPerColor={2}
        softness={1}
        scale={1.4}
        speed={reducedMotion ? 0 : 0.25}
        rotation={0}
        offsetX={0}
        offsetY={0}
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
      <SimplexNoise
        style={{ width: "100%", height: "100%" }}
        colors={[
          "#00000000",
          "#4b556344",
          "#9ca3afaa",
          "#e5e7ebdd",
          "#ffffffee",
        ]}
        stepsPerColor={1}
        softness={1}
        scale={2}
        speed={reducedMotion ? 0 : 0.45}
        rotation={0}
        offsetX={0}
        offsetY={0}
      />
    </ShaderShell>
  );
}

// ─── Fire ──────────────────────────────────────────────────────────────────
//
// Custom fragment shader: stacked simplex-noise FBM, biased upward over
// time, mapped to a red→orange→yellow→transparent gradient with the
// flame's vertical taper. Renders an actual flame tongue with tip
// flicker rather than a bunch of bouncing dots.

const fireFragmentShader = `#version 300 es
precision mediump float;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_pixelRatio;

out vec4 fragColor;

// 2D hash + value noise — fast and good enough for flame
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  // h = 0 at the flame base, 1 at the tip. Paper flips y so we use uv.y directly.
  float h = uv.y;
  float xCenter = abs(uv.x - 0.5);

  float t = u_time * 0.55;
  // Distort vertically faster than horizontally — flames lick upward.
  vec2 p = vec2(uv.x * 2.0, (1.0 - h) * 3.0 - t * 1.5);
  float n = fbm(p);

  // Flame mask: stronger near base, narrower near tip.
  float flame = n * (1.0 - h * 1.4);
  // Pinch sides — narrower flame tongue
  flame -= xCenter * (0.6 + h * 1.5);
  flame = max(0.0, flame);

  // Color ramp: red base → orange → yellow tip.
  vec3 red = vec3(0.95, 0.10, 0.05);
  vec3 orange = vec3(1.00, 0.45, 0.05);
  vec3 yellow = vec3(1.00, 0.85, 0.30);
  vec3 col = mix(red, orange, smoothstep(0.0, 0.45, flame));
  col = mix(col, yellow, smoothstep(0.45, 0.75, flame));

  // Alpha: smooth cutoff at the flame edge, also fade out near tip.
  float alpha = smoothstep(0.04, 0.18, flame) * smoothstep(1.0, 0.4, h);

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
