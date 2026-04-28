"use client";

import { useCallback, useRef, useState } from "react";
import type { BubbleBounds } from "./useReviewEdits";

export type HandleType =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "body";

export type PercentBounds = { x: number; y: number; w: number; h: number };

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

function applyDelta(
  start: PercentBounds,
  dx: number,
  dy: number,
  handle: HandleType,
): PercentBounds {
  let { x, y, w, h } = start;
  const MIN_SIZE = 1;

  switch (handle) {
    case "body":
      x = clamp(x + dx, 0, 100 - w);
      y = clamp(y + dy, 0, 100 - h);
      break;
    case "nw":
      x = clamp(x + dx, 0, x + w - MIN_SIZE);
      y = clamp(y + dy, 0, y + h - MIN_SIZE);
      w = start.x + start.w - x;
      h = start.y + start.h - y;
      break;
    case "n":
      y = clamp(y + dy, 0, y + h - MIN_SIZE);
      h = start.y + start.h - y;
      break;
    case "ne":
      y = clamp(y + dy, 0, y + h - MIN_SIZE);
      h = start.y + start.h - y;
      w = clamp(w + dx, MIN_SIZE, 100 - x);
      break;
    case "e":
      w = clamp(w + dx, MIN_SIZE, 100 - x);
      break;
    case "se":
      w = clamp(w + dx, MIN_SIZE, 100 - x);
      h = clamp(h + dy, MIN_SIZE, 100 - y);
      break;
    case "s":
      h = clamp(h + dy, MIN_SIZE, 100 - y);
      break;
    case "sw":
      x = clamp(x + dx, 0, x + w - MIN_SIZE);
      w = start.x + start.w - x;
      h = clamp(h + dy, MIN_SIZE, 100 - y);
      break;
    case "w":
      x = clamp(x + dx, 0, x + w - MIN_SIZE);
      w = start.x + start.w - x;
      break;
  }

  return { x, y, w, h };
}

function styleToPct(style: {
  left: string;
  top: string;
  width: string;
  height: string;
}): PercentBounds {
  return {
    x: parseFloat(style.left),
    y: parseFloat(style.top),
    w: parseFloat(style.width),
    h: parseFloat(style.height),
  };
}

function pctToDecimal(pct: PercentBounds): BubbleBounds {
  return {
    x: pct.x / 100,
    y: pct.y / 100,
    width: pct.w / 100,
    height: pct.h / 100,
  };
}

export function useBoundsEditor({
  style,
  containerRef,
  onBoundsCommit,
}: {
  style: { left: string; top: string; width: string; height: string };
  containerRef: React.RefObject<HTMLDivElement | null>;
  onBoundsCommit: (bounds: BubbleBounds) => void;
}) {
  const [liveBounds, setLiveBounds] = useState<PercentBounds | null>(null);
  const dragRef = useRef<{
    handle: HandleType;
    startX: number;
    startY: number;
    startBounds: PercentBounds;
  } | null>(null);

  const getContainerDims = useCallback(() => {
    const el = containerRef.current;
    if (!el) return { w: 1, h: 1 };
    const rect = el.getBoundingClientRect();
    return { w: rect.width || 1, h: rect.height || 1 };
  }, [containerRef]);

  const onHandlePointerDown = useCallback(
    (handle: HandleType) =>
      (e: React.PointerEvent<HTMLElement>) => {
        e.stopPropagation();
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = {
          handle,
          startX: e.clientX,
          startY: e.clientY,
          startBounds: styleToPct(style),
        };
      },
    [style],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!dragRef.current) return;
      const { handle, startX, startY, startBounds } = dragRef.current;
      const { w, h } = getContainerDims();
      const dx = ((e.clientX - startX) / w) * 100;
      const dy = ((e.clientY - startY) / h) * 100;
      setLiveBounds(applyDelta(startBounds, dx, dy, handle));
    },
    [getContainerDims],
  );

  const onPointerUp = useCallback(() => {
    if (!dragRef.current || !liveBounds) {
      dragRef.current = null;
      return;
    }
    dragRef.current = null;
    onBoundsCommit(pctToDecimal(liveBounds));
    setLiveBounds(null);
  }, [liveBounds, onBoundsCommit]);

  const currentBounds = liveBounds ?? styleToPct(style);

  return {
    currentBounds,
    isDragging: dragRef.current !== null,
    onHandlePointerDown,
    onPointerMove,
    onPointerUp,
  };
}
