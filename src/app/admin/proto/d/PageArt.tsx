// THROWAWAY spike prototype for comic-reader #325, variant D (the reel).
// Siloed under src/app/admin/proto/d/ — never merged.

"use client";

import Image from "next/image";
import type { Rect } from "./data";

/**
 * The page art, cropped to one rectangle of it. The image sits in a box
 * scaled by `1/frame.w` and offset by `-frame.x/frame.w`, so the crop shows
 * exactly the panel or the whole page the caller asked for, at whatever size
 * the caller renders it. The wrapper is what next/image's `fill` sits inside,
 * since `fill` refuses a style width of its own.
 */
export function PageArt({
  src,
  frame,
  alt,
  className,
}: {
  src: string;
  frame: Rect;
  alt: string;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden bg-neutral-950 ${className ?? ""}`}>
      <div
        className="absolute"
        style={{
          width: `${100 / frame.w}%`,
          height: `${100 / frame.h}%`,
          left: `${(-frame.x / frame.w) * 100}%`,
          top: `${(-frame.y / frame.h) * 100}%`,
        }}
      >
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          loading="eager"
          sizes="100vw"
          style={{ objectFit: "fill", pointerEvents: "none" }}
        />
      </div>
    </div>
  );
}
