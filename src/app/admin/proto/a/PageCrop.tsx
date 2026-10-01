// THROWAWAY prototype for issue #325 (review-flow spike, variant A). Never merges.
// A window onto one region of a page image, done with CSS so nothing is cropped server-side.
import type { Rect } from "./types";

interface PageCropProps {
  url: string;
  rect: Rect;
  /** Page width / height. */
  pageAspect: number;
  /** Window width / height. The parent sets the same ratio on the element. */
  boxAspect: number;
  /** "cover" fills the window (portraits); "contain" shows the whole region. */
  mode: "cover" | "contain";
  /** Extra room around the region, as a share of it. */
  pad?: number;
  className?: string;
  alt: string;
}

export function PageCrop({
  url,
  rect,
  pageAspect,
  boxAspect,
  mode,
  pad = 0.1,
  className,
  alt,
}: PageCropProps) {
  // k is the image width in window widths.
  const byWidth = 1 / Math.max(rect.w, 0.001);
  const byHeight = pageAspect / boxAspect / Math.max(rect.h, 0.001);
  const fit =
    mode === "cover"
      ? Math.max(byWidth, byHeight)
      : Math.min(byWidth, byHeight);
  const k = fit / (1 + pad * 2);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return (
    <div
      className={`relative overflow-hidden ${className ?? ""}`}
      style={{ aspectRatio: String(boxAspect) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        decoding="async"
        draggable={false}
        className="absolute max-w-none select-none"
        style={{
          width: `${k * 100}%`,
          left: `${50 - cx * k * 100}%`,
          top: `${50 - ((cy * k * boxAspect) / pageAspect) * 100}%`,
        }}
      />
    </div>
  );
}
