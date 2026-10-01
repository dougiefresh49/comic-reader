// THROWAWAY spike for issue #325 (review editor variant B). A page image cropped to a region and fitted to its box.
"use client";

import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Box, ProtoPage } from "./types";

/** CSS placement of a page-fraction box inside a viewport showing `region`. */
export function place(box: Box, region: Box): CSSProperties {
  return {
    position: "absolute",
    left: `${((box.x - region.x) / region.w) * 100}%`,
    top: `${((box.y - region.y) / region.h) * 100}%`,
    width: `${(box.w / region.w) * 100}%`,
    height: `${(box.h / region.h) * 100}%`,
  };
}

interface Props {
  page: ProtoPage;
  region: Box;
  className?: string;
  innerClassName?: string;
  children?: ReactNode;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export const Viewport = forwardRef<HTMLDivElement, Props>(function Viewport(
  {
    page,
    region,
    className,
    innerClassName,
    children,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClick,
  },
  innerRef,
) {
  const outer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rw = Math.max(region.w * page.width, 1);
  const rh = Math.max(region.h * page.height, 1);
  const scale = Math.min(size.w / rw, size.h / rh) || 0;

  return (
    <div
      ref={outer}
      className={`relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden ${className ?? ""}`}
    >
      <div
        ref={innerRef}
        style={{ width: rw * scale, height: rh * scale }}
        className={`relative shrink-0 overflow-hidden bg-neutral-900 ${innerClassName ?? ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={page.imageUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute select-none"
          style={{
            maxWidth: "none",
            width: `${100 / region.w}%`,
            height: `${100 / region.h}%`,
            left: `${(-region.x / region.w) * 100}%`,
            top: `${(-region.y / region.h) * 100}%`,
          }}
        />
        {children}
      </div>
    </div>
  );
});
