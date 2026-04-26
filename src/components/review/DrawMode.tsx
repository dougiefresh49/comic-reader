"use client";

import { useRef, useState } from "react";
import type { BubbleBounds } from "~/hooks/useReviewEdits";

interface DrawModeProps {
  active: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onDraw: (bounds: BubbleBounds) => void;
  onCancel: () => void;
}

export function DrawMode({ active, containerRef, onDraw, onCancel }: DrawModeProps) {
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  if (!active) return null;

  const getRelative = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const pos = getRelative(e);
    startRef.current = pos;
    setRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const pos = getRelative(e);
    const x = Math.min(startRef.current.x, pos.x);
    const y = Math.min(startRef.current.y, pos.y);
    const w = Math.abs(pos.x - startRef.current.x);
    const h = Math.abs(pos.y - startRef.current.y);
    setRect({ x, y, w, h });
  };

  const handlePointerUp = () => {
    if (!rect || rect.w < 1 || rect.h < 1) {
      onCancel();
    } else {
      onDraw({
        x: rect.x / 100,
        y: rect.y / 100,
        width: rect.w / 100,
        height: rect.h / 100,
      });
    }
    startRef.current = null;
    setRect(null);
  };

  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {rect && rect.w > 0 && rect.h > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-cyan-400 bg-cyan-400/10"
          style={{
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.w}%`,
            height: `${rect.h}%`,
          }}
        />
      )}
    </div>
  );
}
