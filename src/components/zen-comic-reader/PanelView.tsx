"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageDirectedPanel } from "~/types/panels";
import {
  PANEL_VIEW_EASING,
  PANEL_VIEW_TRANSITION_MS,
  panelTransform,
} from "./PanelView.transforms";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = () => setReduced(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  return reduced;
}

export function PanelDimOverlay({
  bbox,
}: {
  bbox: PageDirectedPanel["boundingBox"];
}) {
  const { x, y, w, h } = bbox;
  const topPct = y * 100;
  const leftPct = x * 100;
  const bhPct = h * 100;
  const innerBottom = (y + h) * 100;
  const innerRight = (x + w) * 100;

  return (
    <>
      <div
        className="pointer-events-auto absolute inset-x-0 top-0 bg-black/50"
        style={{ height: `${topPct}%` }}
        aria-hidden
      />
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0 bg-black/50"
        style={{ top: `${innerBottom}%` }}
        aria-hidden
      />
      <div
        className="pointer-events-auto absolute left-0 bg-black/50"
        style={{
          top: `${topPct}%`,
          width: `${leftPct}%`,
          height: `${bhPct}%`,
        }}
        aria-hidden
      />
      <div
        className="pointer-events-auto absolute right-0 bg-black/50"
        style={{
          top: `${topPct}%`,
          width: `${100 - innerRight}%`,
          height: `${bhPct}%`,
        }}
        aria-hidden
      />
    </>
  );
}

interface PanelViewFrameProps {
  panelViewMode: boolean;
  panels: PageDirectedPanel[];
  panelIndex: number;
  reducedMotion: boolean;
  children: React.ReactNode;
}

/**
 * Wraps the comic page layer: applies zoom/pan toward the active panel and dims non-active regions.
 */
export function PanelViewFrame({
  panelViewMode,
  panels,
  panelIndex,
  reducedMotion,
  children,
}: PanelViewFrameProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () =>
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activePanel = panels[panelIndex];

  const transformStyle = useMemo(() => {
    if (
      !panelViewMode ||
      !activePanel ||
      containerSize.w <= 0 ||
      containerSize.h <= 0
    ) {
      return {
        transform: "translate(0px, 0px) scale(1)",
        transition: reducedMotion
          ? undefined
          : `transform ${PANEL_VIEW_TRANSITION_MS}ms ${PANEL_VIEW_EASING}`,
      };
    }
    const { scale, tx, ty } = panelTransform(
      activePanel.boundingBox,
      containerSize,
      containerSize,
    );
    return {
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      transition: reducedMotion
        ? undefined
        : `transform ${PANEL_VIEW_TRANSITION_MS}ms ${PANEL_VIEW_EASING}`,
      transformOrigin: "0 0" as const,
    };
  }, [panelViewMode, activePanel, containerSize, reducedMotion]);

  // Camera-effect class derived from the active panel's effectTags. Runs
  // forwards-once so the panel settles into a stable pose by the end of
  // its display window. Re-keyed on panel.id so the animation restarts
  // every time we navigate to a new panel.
  const cameraEffectClass =
    !panelViewMode || reducedMotion || !activePanel
      ? ""
      : cameraEffectClassFromTags(activePanel.effectTags);

  return (
    <div
      ref={viewportRef}
      className="relative mx-auto aspect-[2/3] max-h-[calc(100vh-140px)] w-full max-w-[min(100%,calc((100vh-140px)*0.667))] overflow-hidden select-none"
    >
      <div className="relative h-full w-full" style={transformStyle}>
        <div
          key={activePanel?.id ?? "no-panel"}
          className={`relative h-full w-full ${cameraEffectClass}`}
          style={{ transformOrigin: "center center" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Map active panel effect tags to a camera-effect className. Tags
 * compose: a panel can both push-in AND shake. Tailwind's
 * `animate-[name_dur_easing_count_fill]` arbitrary-value syntax
 * references keyframes defined in globals.css.
 *
 * Multiple animations on a single element merge into one
 * `animation` shorthand list, which works here because each
 * keyframe sets a single transform-prop slice (scale OR translate)
 * — the browser composes them via the `animation-composition` default
 * (`replace`) and we get the last-set value. For simple single-
 * effect panels (the common case) this is fine.
 *
 * If a panel mixes scale + shake we'd want a layered structure, but
 * since panel-direction usually picks one camera tag per panel
 * (Gemini ranks them) we accept the simpler model for v1.
 */
function cameraEffectClassFromTags(tags: string[]): string {
  const classes: string[] = [];
  // Pick the first matching scale/pan tag; pick the first matching shake.
  for (const tag of tags) {
    switch (tag) {
      case "camera_push_in_slow":
        classes.push("animate-[cameraPushInSlow_6s_ease-out_forwards]");
        break;
      case "camera_push_in_fast":
        classes.push("animate-[cameraPushInFast_0.6s_ease-out_forwards]");
        break;
      case "camera_pull_back":
        classes.push("animate-[cameraPullBack_5s_ease-out_forwards]");
        break;
      case "camera_pan_horizontal":
        classes.push(
          "animate-[cameraPanHorizontal_8s_ease-in-out_infinite_alternate]",
        );
        break;
      case "panel_shake_subtle":
        classes.push("animate-[panelShakeSubtle_0.4s_steps(8)_1]");
        break;
      case "panel_shake_hard":
        classes.push("animate-[panelShakeHard_0.6s_steps(12)_1]");
        break;
    }
    if (classes.length > 0) break; // only one camera tag per panel
  }
  return classes.join(" ");
}

interface PanelViewHudProps {
  panelIndex: number;
  panelCount: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  panelAutoPlay: boolean;
  onTogglePanelAutoPlay: () => void;
  announceText: string;
}

export function PanelViewHud({
  panelIndex,
  panelCount,
  onClose,
  onPrev,
  onNext,
  panelAutoPlay,
  onTogglePanelAutoPlay,
  announceText,
}: PanelViewHudProps) {
  const humanIndex = panelCount > 0 ? panelIndex + 1 : 0;
  const progress = panelCount > 0 ? humanIndex / panelCount : 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 px-1">
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announceText}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-200">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-white/10 px-3 py-1.5 font-medium hover:bg-white/15"
          aria-label="Close panel view"
        >
          × Close
        </button>

        <span className="text-neutral-400 tabular-nums">
          Panel {humanIndex} of {panelCount}
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onTogglePanelAutoPlay}
            className={`rounded-lg px-3 py-1.5 font-medium ${
              panelAutoPlay ? "bg-cyan-600 text-white" : "bg-white/10"
            }`}
            aria-label={
              panelAutoPlay ? "Pause panel auto-play" : "Start panel auto-play"
            }
            aria-pressed={panelAutoPlay}
          >
            {panelAutoPlay ? "⏸ Pause" : "⏯ Play"}
          </button>

          <button
            type="button"
            onClick={onPrev}
            disabled={panelIndex <= 0}
            className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15 disabled:opacity-30"
            aria-label="Previous panel"
          >
            ‹ Prev
          </button>

          <button
            type="button"
            onClick={onNext}
            disabled={panelIndex >= panelCount - 1}
            className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15 disabled:opacity-30"
            aria-label="Next panel"
          >
            Next ›
          </button>
        </div>
      </div>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-white/10"
        aria-hidden
      >
        <div
          className="h-full rounded-full bg-cyan-500/80 transition-[width] duration-300 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
