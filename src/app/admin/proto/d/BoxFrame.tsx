// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import { useCallback, useRef } from "react";
import type { Rect } from "./data";

/**
 * Pointer dragging for one box on a page. Both the enlarged panel in the
 * filmstrip and the whole-page view use it, so a box behaves the same in
 * either place. All coordinates are page fractions; the frame rect is the
 * slice of the page the box is being shown in, which may be the whole page
 * or one panel.
 */
export function useBoxDrag() {
  const startRef = useRef<{
    mode: "move" | "resize";
    handle: string;
    rect: Rect;
    originX: number;
    originY: number;
    /** The element whose on-screen box the frame occupies. */
    host: Element | null;
  } | null>(null);

  const onPointerDown = useCallback(
    (
      event: React.PointerEvent,
      rect: Rect,
      frame: Rect,
      commit: (next: Rect) => void,
      handle: string,
      host: Element | null,
    ) => {
      event.stopPropagation();
      event.preventDefault();
      startRef.current = {
        mode: handle === "move" ? "move" : "resize",
        handle,
        rect,
        originX: event.clientX,
        originY: event.clientY,
        host,
      };
      const target = event.currentTarget as Element;
      target.setPointerCapture(event.pointerId);
      void frame;
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent, frame: Rect, commit: (next: Rect) => void) => {
      const start = startRef.current;
      if (!start) return;
      // One screen pixel in page fractions, measured against the frame host
      // rather than the page's stored pixel size, so the drag tracks the
      // pointer in both the small strip and the full page. It must be the
      // host and not `event.currentTarget`: on a resize that is the corner
      // handle, a dozen pixels wide, which would scale the drag by 100x.
      const host = (start.host ?? event.currentTarget).getBoundingClientRect();
      const perPxX = frame.w / Math.max(host.width, 1);
      const perPxY = frame.h / Math.max(host.height, 1);
      const dx = (event.clientX - start.originX) * perPxX;
      const dy = (event.clientY - start.originY) * perPxY;
      const r = start.rect;

      if (start.mode === "move") {
        commit({
          x: clamp01(r.x + dx, 1 - r.w),
          y: clamp01(r.y + dy, 1 - r.h),
          w: r.w,
          h: r.h,
        });
        return;
      }

      let { x, y, w, h } = r;
      if (start.handle.includes("e")) w = Math.max(0.01, r.w + dx);
      if (start.handle.includes("s")) h = Math.max(0.01, r.h + dy);
      if (start.handle.includes("w")) {
        w = Math.max(0.01, r.w - dx);
        x = r.x + (r.w - w);
      }
      if (start.handle.includes("n")) {
        h = Math.max(0.01, r.h - dy);
        y = r.y + (r.h - h);
      }
      commit({ x, y, w, h });
    },
    [],
  );

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    startRef.current = null;
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}

function clamp01(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** A box's position inside a frame, as percentages of the frame box. */
export function rectInFrame(rect: Rect, frame: Rect) {
  return {
    left: ((rect.x - frame.x) / frame.w) * 100,
    top: ((rect.y - frame.y) / frame.h) * 100,
    width: (rect.w / frame.w) * 100,
    height: (rect.h / frame.h) * 100,
  };
}

export const RESIZE_HANDLES = ["nw", "ne", "se", "sw"] as const;
