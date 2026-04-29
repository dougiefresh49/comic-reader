"use client";

import { useCallback, useRef } from "react";
import type { HTMLAttributes } from "react";

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_MAX_DIST = 28;

/**
 * Detects double primary-button taps for entering/exiting panel view.
 */
export function useDoubleTap(onDoubleTap: () => void) {
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  return useCallback(
    (): HTMLAttributes<HTMLElement> => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        const now = Date.now();
        const prev = lastTapRef.current;
        lastTapRef.current = {
          t: now,
          x: e.clientX,
          y: e.clientY,
        };
        if (!prev) return;
        const dt = now - prev.t;
        const dist = Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
        if (dt < DOUBLE_TAP_MS && dist < DOUBLE_TAP_MAX_DIST) {
          lastTapRef.current = null;
          onDoubleTap();
        }
      },
    }),
    [onDoubleTap],
  );
}
