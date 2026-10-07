"use client";

import { useMemo } from "react";
import {
  useActiveWordIndex,
  useWordHighlightSelector,
  type WordHighlightStore,
} from "~/hooks/useWordHighlight";
import { ACTIVE_OPACITY } from "~/lib/highlight-color";
import {
  alignTimingsToGeometry,
  type WordGeometryMatch,
} from "~/lib/word-geometry-match";
import type { Box, TextGeometry } from "~/types/text-geometry";
import type { WordTiming } from "./text-utils";

/** Below this share of lettered words matched, the caption carries the bubble. */
const MIN_COVERAGE = 0.8;

const TRAIL_OPACITY = 0.3;
/** Longest wipe across the active word, before dividing by playbackRate. */
const WIPE_MAX_MS = 220;
/** Padding around a word box, as a share of the box height. */
const PAD_X = 0.08;
const PAD_Y = 0.04;
/** Corner radius, as a share of the padded box height. */
const RADIUS = 0.15;

/**
 * The timing↔box match for a bubble when it is good enough to light words on
 * the art, else null (no geometry, no timings, or coverage under 0.8). `words`
 * must be the caption's `buildWordTimings` list, so index N is the same word
 * in both places.
 */
export function inBubbleMatch(
  words: WordTiming[],
  geometry: TextGeometry | null | undefined,
): WordGeometryMatch | null {
  if (!geometry || !words.length) return null;
  const match = alignTimingsToGeometry(words, geometry);
  return match.coverage >= MIN_COVERAGE ? match : null;
}

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  ry: number;
};

/**
 * Pads every box by a share of its height, never past half the gap to a
 * neighbouring line (lettered lines sit close), and rounds its corners.
 * `aspect` is page height / page width: the viewBox is 1x1 stretched over
 * the page, so a length taken from a height is scaled by it on the x axis.
 */
function padBoxes(boxesByTimingIndex: Box[][], aspect: number): Rect[][] {
  const all = boxesByTimingIndex.flat();
  return boxesByTimingIndex.map((boxes) =>
    boxes.map(([x, y, w, h]) => {
      let gap = Infinity;
      for (const [ox, oy, ow, oh] of all) {
        const overlapsX = ox < x + w && x < ox + ow;
        if (!overlapsX) continue;
        if (oy >= y + h) gap = Math.min(gap, oy - (y + h));
        else if (oy + oh <= y) gap = Math.min(gap, y - (oy + oh));
      }
      const padY = Math.min(PAD_Y * h, gap / 2);
      const padX = PAD_X * h * aspect;
      const ph = h + padY * 2;
      return {
        x: x - padX,
        y: y - padY,
        w: w + padX * 2,
        h: ph,
        rx: RADIUS * ph * aspect,
        ry: RADIUS * ph,
      };
    }),
  );
}

/** The lit word: the active one, or the last earlier word that has a box. */
function litIndex(index: number | null, rects: Rect[][]): number | null {
  if (index === null) return null;
  for (let i = Math.min(index, rects.length - 1); i >= 0; i--) {
    if (rects[i]?.length) return i;
  }
  return null;
}

interface BubbleWordHighlightProps {
  wordHighlight: WordHighlightStore;
  bubbleId: string;
  words: WordTiming[];
  boxesByTimingIndex: Box[][];
  /** Page height / page width. */
  aspect: number;
  /** System reduced motion or Motion "Off": no wipe. */
  reducedMotion: boolean;
  /** The marker colour, from `highlightColorFor` on the bubble's fill (#575). */
  color: string;
}

/**
 * The spoken word lit on the page art (#87): a marker over the active word
 * that wipes in left to right, and a faint trail over the words already
 * read. Renders in the page plane, so it follows the panel camera. The
 * caption stays the accessible text.
 */
export function BubbleWordHighlight({
  wordHighlight,
  bubbleId,
  words,
  boxesByTimingIndex,
  aspect,
  reducedMotion,
  color,
}: BubbleWordHighlightProps) {
  const index = useActiveWordIndex(wordHighlight, bubbleId);
  const paused = useWordHighlightSelector(wordHighlight, (s) => s.paused);
  const rate = useWordHighlightSelector(wordHighlight, (s) => s.rate);

  const rects = useMemo(
    () => padBoxes(boxesByTimingIndex, aspect),
    [boxesByTimingIndex, aspect],
  );
  const lit = litIndex(index, rects);
  if (lit === null) return null;

  const word = words[lit];
  const wipeMs =
    reducedMotion || !word
      ? 0
      : Math.min(Math.max(word.end - word.start, 0) * 1000, WIPE_MAX_MS) /
        (rate > 0 ? rate : 1);

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      // Multiply keeps black lettering black under the marker.
      style={{ mixBlendMode: "multiply" }}
    >
      <style>
        {
          "@keyframes bubble-word-wipe{from{transform:scaleX(0)}to{transform:scaleX(1)}}"
        }
      </style>
      <g fill={color} opacity={TRAIL_OPACITY}>
        {rects
          .slice(0, lit)
          .flatMap((boxes, i) =>
            boxes.map((r, j) => (
              <rect
                key={`${i}-${j}`}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                rx={r.rx}
                ry={r.ry}
              />
            )),
          )}
      </g>
      {/* Keyed by word, so the wipe restarts on each new word. */}
      <g key={lit} fill={color} opacity={ACTIVE_OPACITY}>
        {rects[lit]!.map((r, j) => (
          <rect
            key={j}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={r.rx}
            ry={r.ry}
            style={
              wipeMs > 0
                ? {
                    transformBox: "fill-box",
                    transformOrigin: "0 50%",
                    // Longhands, not the `animation` shorthand: a rate change
                    // re-applies the duration, and the shorthand would reset
                    // play-state to running while the audio is paused.
                    animationName: "bubble-word-wipe",
                    animationDuration: `${wipeMs}ms`,
                    animationTimingFunction: "ease-out",
                    animationFillMode: "both",
                    animationPlayState: paused ? "paused" : "running",
                  }
                : undefined
            }
          />
        ))}
      </g>
    </svg>
  );
}
