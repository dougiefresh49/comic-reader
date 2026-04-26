"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

const MIN_SWIPE_DISTANCE = 50;
const MIN_SCALE = 1;
const MAX_SCALE = 3.5;

function distanceBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function clampScale(v: number) {
  return Math.min(Math.max(v, MIN_SCALE), MAX_SCALE);
}

function clampOffset(v: number) {
  return Math.min(Math.max(v, -520), 520);
}

interface UsePinchZoomOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

export function usePinchZoom({
  onSwipeLeft,
  onSwipeRight,
}: UsePinchZoomOptions = {}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const scaleRef = useRef(1);
  const pointerMapRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);
  const swipeStartRef = useRef<number | null>(null);
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const onSwipeRightRef = useRef(onSwipeRight);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    onSwipeLeftRef.current = onSwipeLeft;
  }, [onSwipeLeft]);

  useEffect(() => {
    onSwipeRightRef.current = onSwipeRight;
  }, [onSwipeRight]);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    if (pointers.size === 1 && scaleRef.current === 1) {
      swipeStartRef.current = e.clientX;
    }

    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values()) as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinchRef.current = {
        distance: distanceBetween(first, second),
        scale: scaleRef.current,
      };
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && pinchRef.current) {
      const [first, second] = Array.from(pointers.values()) as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const ratio =
        distanceBetween(first, second) / (pinchRef.current.distance || 1);
      const nextScale = clampScale(pinchRef.current.scale * ratio);
      setScale(nextScale);
      return;
    }

    if (pointers.size === 1 && scaleRef.current > 1 && prev) {
      setOffset((cur) => ({
        x: clampOffset(cur.x + e.clientX - prev.x),
        y: clampOffset(cur.y + e.clientY - prev.y),
      }));
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const pointers = pointerMapRef.current;
    const wasPinch = pointers.size === 2;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchRef.current = null;

    if (!wasPinch && scaleRef.current === 1 && swipeStartRef.current !== null) {
      const delta = e.clientX - swipeStartRef.current;
      if (delta > MIN_SWIPE_DISTANCE) onSwipeRightRef.current?.();
      if (delta < -MIN_SWIPE_DISTANCE) onSwipeLeftRef.current?.();
    }
    swipeStartRef.current = null;
  }, []);

  return {
    scale,
    offset,
    resetView,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
