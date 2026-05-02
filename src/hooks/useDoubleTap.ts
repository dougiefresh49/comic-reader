"use client";

import { useCallback, useRef } from "react";
import type { HTMLAttributes } from "react";

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_MAX_DIST = 28;

export function useDoubleTap(
  onDoubleTap: () => void,
  onSingleTap?: () => void,
) {
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (): HTMLAttributes<HTMLElement> => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;

        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest("a")) return;

        const now = Date.now();
        const prev = lastTapRef.current;
        lastTapRef.current = {
          t: now,
          x: e.clientX,
          y: e.clientY,
        };
        if (
          prev &&
          now - prev.t < DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <
            DOUBLE_TAP_MAX_DIST
        ) {
          lastTapRef.current = null;
          if (singleTapTimerRef.current) {
            clearTimeout(singleTapTimerRef.current);
            singleTapTimerRef.current = null;
          }
          onDoubleTap();
          return;
        }
        if (onSingleTap) {
          if (singleTapTimerRef.current) {
            clearTimeout(singleTapTimerRef.current);
          }
          singleTapTimerRef.current = setTimeout(() => {
            singleTapTimerRef.current = null;
            onSingleTap();
          }, DOUBLE_TAP_MS);
        }
      },
    }),
    [onDoubleTap, onSingleTap],
  );
}
