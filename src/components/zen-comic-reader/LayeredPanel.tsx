"use client";

import { useId } from "react";
import Image from "next/image";
import type { ReaderSpread } from "~/lib/spreads";
import type {
  PanelBoundingBox,
  PanelForegroundPolygons,
  PanelLocalPolygon,
} from "~/types/panels";

interface PageArtProps {
  pageImage: string;
  /** Set on a spread (#724): both pages side by side across the plane. */
  spread?: ReaderSpread | null;
  alt: string;
  style?: React.CSSProperties;
}

/**
 * The page art filling the page plane. A single page is the one image it
 * always was; a spread is its two images side by side, the left one across
 * `leftShare` of the plane and the right one across the rest, meeting at
 * the seam. `style` (a clip path) applies to the art as a whole.
 */
export function PageArt({ pageImage, spread, alt, style }: PageArtProps) {
  if (!spread) {
    return (
      <Image
        src={pageImage}
        alt={alt}
        fill
        className="object-contain"
        style={style}
        priority
        aria-hidden={alt ? undefined : true}
      />
    );
  }
  const share = spread.leftShare * 100;
  return (
    <div
      className="absolute inset-0"
      style={style}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      {[
        { page: spread.left, left: 0, width: share },
        { page: spread.right, left: share, width: 100 - share },
      ].map(({ page, left, width }) => (
        <div
          key={page.pageNumber}
          className="absolute inset-y-0"
          style={{ left: `${left}%`, width: `${width}%` }}
        >
          <Image
            src={page.image}
            alt=""
            fill
            className="object-contain"
            priority
          />
        </div>
      ))}
    </div>
  );
}

interface LayeredPanelProps {
  pageImage: string;
  spread?: ReaderSpread | null;
  bbox: PanelBoundingBox;
  polygons: PanelForegroundPolygons;
  effectsSlot: React.ReactNode;
}

function polyToSvgPath(
  poly: PanelLocalPolygon,
  bbox: PanelBoundingBox,
): string {
  const points = poly.map((pt) => {
    const x = bbox.x + pt.x * bbox.w;
    const y = bbox.y + pt.y * bbox.h;
    return `${x.toFixed(4)} ${y.toFixed(4)}`;
  });
  return `M ${points.join(" L ")} Z`;
}

export function LayeredPanel({
  pageImage,
  spread,
  bbox,
  polygons,
  effectsSlot,
}: LayeredPanelProps) {
  const clipId = useId();
  const allPolys = [...polygons.characters, ...polygons.bubbles].filter(
    (p) => p.length >= 3,
  );

  if (allPolys.length === 0) {
    return (
      <>
        <PageArt pageImage={pageImage} spread={spread} alt="Comic page" />
        {effectsSlot}
      </>
    );
  }

  const fgPaths = allPolys.map((p) => polyToSvgPath(p, bbox));
  const bgPath = `M 0 0 L 1 0 L 1 1 L 0 1 Z ${fgPaths.join(" ")}`;
  const fgPath = fgPaths.join(" ");

  return (
    <>
      <svg className="absolute" width="0" height="0" aria-hidden>
        <defs>
          <clipPath id={`${clipId}-bg`} clipPathUnits="objectBoundingBox">
            <path d={bgPath} clipRule="evenodd" fillRule="evenodd" />
          </clipPath>
          <clipPath id={`${clipId}-fg`} clipPathUnits="objectBoundingBox">
            <path d={fgPath} />
          </clipPath>
        </defs>
      </svg>

      <PageArt
        pageImage={pageImage}
        spread={spread}
        alt=""
        style={{ clipPath: `url(#${clipId}-bg)` }}
      />

      {effectsSlot}

      <PageArt
        pageImage={pageImage}
        spread={spread}
        alt="Comic page"
        style={{ clipPath: `url(#${clipId}-fg)` }}
      />
    </>
  );
}
