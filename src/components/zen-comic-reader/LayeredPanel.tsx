"use client";

import { useId } from "react";
import Image from "next/image";
import type {
  PanelBoundingBox,
  PanelForegroundPolygons,
  PanelLocalPolygon,
} from "~/types/panels";

interface LayeredPanelProps {
  pageImage: string;
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
        <Image
          src={pageImage}
          alt="Comic page"
          fill
          className="object-contain"
          priority
        />
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

      <Image
        src={pageImage}
        alt=""
        fill
        className="object-contain"
        style={{ clipPath: `url(#${clipId}-bg)` }}
        priority
        aria-hidden
      />

      {effectsSlot}

      <Image
        src={pageImage}
        alt="Comic page"
        fill
        className="object-contain"
        style={{ clipPath: `url(#${clipId}-fg)` }}
        priority
      />
    </>
  );
}
