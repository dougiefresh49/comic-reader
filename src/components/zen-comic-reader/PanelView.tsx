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

  return (
    <div
      ref={viewportRef}
      className="relative mx-auto aspect-[2/3] max-h-[calc(100vh-140px)] w-full max-w-[min(100%,calc((100vh-140px)*0.667))] overflow-hidden select-none"
    >
      <div className="relative h-full w-full" style={transformStyle}>
        {children}
      </div>
    </div>
  );
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
