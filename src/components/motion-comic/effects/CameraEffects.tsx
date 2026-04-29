"use client";

import type { EffectProps } from "./types";

/**
 * Camera transforms aren't rendered like other effect overlays — they
 * apply to the page layer inside PanelViewFrame (see
 * cameraEffectClassFromTags in PanelView.tsx). For the effects-preview
 * gallery, however, we need a visible component per tag so users can
 * eyeball the motion. Each preview wraps a stylised marker box in the
 * same keyframe animation that PanelViewFrame would apply at runtime.
 *
 * In production these components are still registered, but they no-op
 * because the camera transform happens upstream — the visible result
 * the user sees comes from PanelViewFrame, not these stub overlays.
 */

interface DemoProps {
  bbox: EffectProps["bbox"];
  active: boolean;
  reducedMotion: boolean;
  /** Tailwind animation class applied to the marker box. */
  animationClass: string;
  /** Tooltip text shown in the demo. */
  label: string;
}

function CameraDemo({
  bbox,
  active,
  reducedMotion,
  animationClass,
  label,
}: DemoProps) {
  if (!active) return null;
  const cls = reducedMotion ? "" : animationClass;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: `${bbox.x * 100}%`,
        top: `${bbox.y * 100}%`,
        width: `${bbox.w * 100}%`,
        height: `${bbox.h * 100}%`,
      }}
    >
      <div
        className={`flex h-full w-full items-center justify-center rounded border-4 border-cyan-400/40 bg-cyan-500/10 ${cls}`}
        style={{ transformOrigin: "center center" }}
      >
        <span className="rounded bg-black/60 px-2 py-1 font-mono text-[10px] text-cyan-100">
          {label}
        </span>
      </div>
    </div>
  );
}

export function CameraPushInSlowDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[cameraPushInSlow_6s_ease-out_forwards]"
      label="push-in (slow)"
    />
  );
}
export function CameraPushInFastDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[cameraPushInFast_0.6s_ease-out_forwards]"
      label="push-in (fast)"
    />
  );
}
export function CameraPullBackDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[cameraPullBack_5s_ease-out_forwards]"
      label="pull back"
    />
  );
}
export function CameraPanHorizontalDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[cameraPanHorizontal_8s_ease-in-out_infinite_alternate]"
      label="pan ←→"
    />
  );
}
export function PanelShakeSubtleDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[panelShakeSubtle_0.4s_steps(8)_infinite]"
      label="shake (subtle)"
    />
  );
}
export function PanelShakeHardDemo(p: EffectProps) {
  return (
    <CameraDemo
      {...p}
      animationClass="animate-[panelShakeHard_0.6s_steps(12)_infinite]"
      label="shake (hard)"
    />
  );
}
