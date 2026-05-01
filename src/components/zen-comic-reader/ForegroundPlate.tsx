import Image from "next/image";
import { useId, useMemo } from "react";
import type { PageDirectedPanel, PanelLocalPolygon } from "~/types/panels";

interface ForegroundPlateProps {
  pageImage: string;
  panels: PageDirectedPanel[];
  /** Stack above particle effects so characters render on top of them. */
  className?: string;
}

/**
 * Renders a copy of the page WebP clipped to the union of every panel's
 * foreground polygons (character/face/head + speech bubbles). The reader
 * stacks this above the particle effect overlay so particles render
 * "behind" characters and bubbles without baking masks at ingest time.
 *
 * Polygons in `panel.foregroundPolygons` are panel-local 0..1 — converted
 * to page-local 0..1 here using each panel's `boundingBox`.
 *
 * Returns null if no panel has foreground polygons (graceful fallback to
 * the existing un-layered render).
 *
 * Must be placed inside a parent container whose aspect ratio matches the
 * page image — the SVG clip uses `objectBoundingBox` units, which only
 * align with the image content when the box and image share the same
 * aspect ratio (PanelViewFrame already enforces aspect-[2/3]).
 */
export function ForegroundPlate({
  pageImage,
  panels,
  className = "pointer-events-none absolute inset-0 z-20",
}: ForegroundPlateProps) {
  const clipId = useId();
  const polygons = useMemo(() => collectPagePolygons(panels), [panels]);

  if (polygons.length === 0) return null;

  return (
    <>
      <svg
        aria-hidden
        width={0}
        height={0}
        className="absolute"
        style={{ position: "absolute", width: 0, height: 0 }}
      >
        <defs>
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            {polygons.map((points, i) => (
              <polygon key={i} points={points} />
            ))}
          </clipPath>
        </defs>
      </svg>
      <div
        aria-hidden
        className={className}
        style={{ clipPath: `url(#${clipId})` }}
      >
        <Image
          src={pageImage}
          alt=""
          fill
          className="object-contain"
          // Same priority hint as the bg plate so we don't double-fetch.
          priority
        />
      </div>
    </>
  );
}

/**
 * Convert every panel's panel-local foreground polygons to page-local 0..1
 * and emit them as `points` strings ready to drop into <polygon>.
 *
 * Both character and bubble polygons go into the same bucket — the runtime
 * needs them to render on top of particle effects together. (The bubble
 * exclusion-zone for particle emission is a separate downstream concern.)
 */
function collectPagePolygons(panels: PageDirectedPanel[]): string[] {
  const out: string[] = [];
  for (const panel of panels) {
    if (!panel.foregroundPolygons) continue;
    const { boundingBox: bb } = panel;
    const sets = [
      panel.foregroundPolygons.characters,
      panel.foregroundPolygons.bubbles,
    ];
    for (const polys of sets) {
      for (const poly of polys) {
        const points = polyToPagePoints(poly, bb);
        if (points) out.push(points);
      }
    }
  }
  return out;
}

function polyToPagePoints(
  poly: PanelLocalPolygon,
  bb: { x: number; y: number; w: number; h: number },
): string | null {
  if (poly.length < 3) return null;
  const parts: string[] = [];
  for (const p of poly) {
    const px = bb.x + p.x * bb.w;
    const py = bb.y + p.y * bb.h;
    // Clamp to valid 0..1 range — small RDP-induced overshoots break clipping.
    const cx = Math.max(0, Math.min(1, px));
    const cy = Math.max(0, Math.min(1, py));
    parts.push(`${cx.toFixed(4)},${cy.toFixed(4)}`);
  }
  return parts.join(" ");
}
