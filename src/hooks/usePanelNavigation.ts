"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { useGesture } from "@use-gesture/react";

const SWIPE_MIN_DISTANCE = 60;

export interface UsePanelNavigationOptions {
  panelCount: number;
  /** When false, gestures no-op (single-page full reader uses outer pinch). */
  enabled: boolean;
  onExit: () => void;
  onTogglePanelAutoPlay?: () => void;
  /** Called when the user advances past the last panel — wire to next-page nav. */
  onPastEnd?: () => void;
  /** Called when the user advances before the first panel — wire to prev-page nav. */
  onBeforeStart?: () => void;
}

export interface UsePanelNavigationResult {
  panelIndex: number;
  setPanelIndex: React.Dispatch<React.SetStateAction<number>>;
  goNext: () => void;
  goPrev: () => void;
  gestureBind: () => React.HTMLAttributes<HTMLElement>;
  panelContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function usePanelNavigation({
  panelCount,
  enabled,
  onExit,
  onTogglePanelAutoPlay,
  onPastEnd,
  onBeforeStart,
}: UsePanelNavigationOptions): UsePanelNavigationResult {
  const [panelIndex, setPanelIndexState] = useState(0);
  // The index as of the last set, read synchronously. React may defer a
  // useState updater to the next render, so a past-the-end decision made
  // inside one can be read too early and dropped (#514).
  const panelIndexRef = useRef(0);
  const panelContainerRef = useRef<HTMLDivElement | null>(null);

  const setPanelIndex = useCallback<
    React.Dispatch<React.SetStateAction<number>>
  >((action) => {
    const next =
      typeof action === "function" ? action(panelIndexRef.current) : action;
    panelIndexRef.current = next;
    setPanelIndexState(next);
  }, []);

  const clampIndex = useCallback(
    (i: number) => Math.max(0, Math.min(panelCount - 1, i)),
    [panelCount],
  );

  const goNext = useCallback(() => {
    const i = panelIndexRef.current;
    if (i >= panelCount - 1) onPastEnd?.();
    else setPanelIndex(clampIndex(i + 1));
  }, [clampIndex, panelCount, onPastEnd, setPanelIndex]);

  const goPrev = useCallback(() => {
    const i = panelIndexRef.current;
    if (i <= 0) onBeforeStart?.();
    else setPanelIndex(clampIndex(i - 1));
  }, [clampIndex, onBeforeStart, setPanelIndex]);

  useEffect(() => {
    setPanelIndex((i) => clampIndex(i));
  }, [panelCount, clampIndex, setPanelIndex]);

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "BUTTON" ||
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        onTogglePanelAutoPlay?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onExit, goNext, goPrev, onTogglePanelAutoPlay]);

  const gestureBind = useGesture(
    {
      onDragEnd: ({ movement: [mx], canceled }) => {
        if (!enabled || canceled) return;
        if (mx < -SWIPE_MIN_DISTANCE) goNext();
        else if (mx > SWIPE_MIN_DISTANCE) goPrev();
      },
      onWheel: ({ event, delta: [dx, dy], ctrlKey }) => {
        if (!enabled) return;
        if (ctrlKey) return;
        const dominant = Math.abs(dx) > Math.abs(dy) ? dx : 0;
        if (Math.abs(dominant) < 40) return;
        event.preventDefault();
        if (dominant < 0) goNext();
        else goPrev();
      },
      onPinchEnd: ({ offset }) => {
        if (!enabled) return;
        const scale = offset[0] ?? 1;
        if (scale < 0.92) onExit();
      },
    },
    {
      drag: {
        axis: "lock",
        filterTaps: true,
        threshold: 12,
      },
      wheel: {
        eventOptions: { passive: false },
      },
      pinch: {
        scaleBounds: { min: 0.6, max: 1.4 },
        rubberband: true,
      },
      enabled,
    },
  );

  return {
    panelIndex,
    setPanelIndex,
    goNext,
    goPrev,
    gestureBind,
    panelContainerRef,
  };
}
