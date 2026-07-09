"use client";

import { useState } from "react";
import Image from "next/image";

interface CoverImageProps {
  /** Image URL, or null to render the placeholder immediately. */
  src: string | null;
  alt: string;
  /**
   * Monogram shown on the placeholder — an issue number ("#3") or a
   * title monogram ("TM"). Kept short and bold.
   */
  fallbackLabel: string;
  /**
   * Caption under the monogram. Defaults to "Cover unavailable";
   * pass null to hide it (e.g. coming-soon cards that carry their
   * own chip).
   */
  fallbackCaption?: string | null;
  sizes?: string;
  priority?: boolean;
  /** Extra classes for the underlying next/image element. */
  className?: string;
}

/**
 * Cover artwork with a styled failure state. Renders `next/image`
 * with `fill`, so the parent must be `relative` with a fixed aspect
 * ratio (e.g. `relative aspect-[2/3] overflow-hidden rounded-xl`).
 *
 * If the source is missing or 404s, a neutral card with a subtle
 * cyan wash and a monogram takes its place — a raw broken-image
 * glyph is impossible.
 */
export function CoverImage({
  src,
  alt,
  fallbackLabel,
  fallbackCaption = "Cover unavailable",
  sizes,
  priority,
  className,
}: CoverImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className="relative flex h-full w-full flex-col items-center justify-center gap-1.5 bg-neutral-900"
      >
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(80%_60%_at_50%_0%,rgba(34,211,238,0.10),transparent)]"
        />
        <span className="relative text-3xl font-bold tracking-wide text-neutral-400 tabular-nums">
          {fallbackLabel}
        </span>
        {fallbackCaption ? (
          <span className="relative text-[10px] font-medium tracking-[0.08em] text-neutral-500 uppercase">
            {fallbackCaption}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      className={`object-cover ${className ?? ""}`}
      onError={() => setFailed(true)}
    />
  );
}
