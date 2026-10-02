import { area, intersectArea, type FilterablePanel } from "~/lib/panel-filter";
import type { PanelBoundingBox } from "~/types/panels";

/** Anything carrying a bubble box and its detection confidence. */
export type FilterableBubble = FilterablePanel & { confidence: number };

/**
 * Share of a smaller box that must lie inside a larger one for the larger to
 * hold it. 0.9 is the #225 strip threshold. On the #97 smoke page each
 * dropped box holds a balloon at 0.98 or more, while no kept balloon has
 * even 0.3 of its box inside another kept box, so neighbours stay apart.
 */
const HOLD_COVER = 0.9;

/**
 * How much larger a box must be than one it holds before it counts as the
 * looser detection. Below this the two are twins, settled by confidence. The
 * smallest case on the smoke page is 1.7 times (a balloon and its tighter
 * box); 1.2 is the review prototype's value.
 */
const HOLD_GROWTH = 1.2;

/**
 * Share of a box's width or height that the boxes it holds must span
 * together, measured as the extent of their union along that axis, for it
 * to be a duplicate container. The #225 strip rule's test, judged on
 * everything held at once: a loose box or a box over a split balloon's
 * lobes is filled edge to edge on some axis (0.99 across "LET THE FIRE…"
 * and "…ENGULF…" on the smoke page), while a big balloon with a separate
 * small one inside its box ("DUDES…" around "EXACTLY!", 0.36 wide) is not.
 */
const HOLD_SPAN = 0.75;

/**
 * Intersection over union at which two boxes of similar size are one
 * detection twice. The review prototype's value. The smoke page has two twin
 * pairs, both loose containers: 0.97 ("LET THE FIRE…") and 0.66 ("DUDES…").
 */
const TWIN_IOU = 0.6;

const iou = (a: FilterablePanel, b: FilterablePanel) => {
  const inter = intersectArea(a.bounding_box, b.bounding_box);
  const union = area(a.bounding_box) + area(b.bounding_box) - inter;
  return union > 0 ? inter / union : 0;
};

/** True when 0.9 of `small` lies inside `big` and `big` is 1.2 times its area. */
function holds(big: FilterablePanel, small: FilterablePanel): boolean {
  const smallArea = area(small.bounding_box);
  if (smallArea <= 0) return false;
  if (area(big.bounding_box) < HOLD_GROWTH * smallArea) return false;
  return (
    intersectArea(big.bounding_box, small.bounding_box) >=
    HOLD_COVER * smallArea
  );
}

/**
 * True when the `held` boxes together span 0.75 of `big`'s width or height:
 * from the leftmost (topmost) held edge to the rightmost (bottommost),
 * clipped to `big`.
 */
function spansTogether(big: PanelBoundingBox, held: PanelBoundingBox[]) {
  if (held.length === 0) return false;
  const extent = (k: "x" | "y", s: "w" | "h") =>
    Math.min(big[k] + big[s], Math.max(...held.map((b) => b[k] + b[s]))) -
    Math.max(big[k], Math.min(...held.map((b) => b[k])));
  return (
    extent("x", "w") >= HOLD_SPAN * big.w ||
    extent("y", "h") >= HOLD_SPAN * big.h
  );
}

/**
 * Split bubble detections into kept and dropped, one box per balloon (#311),
 * in two passes:
 *
 * 1. Twins: of two boxes at IoU 0.6 or more, the lower confidence drops (on
 *    a tie, the later box). Boxes are judged highest confidence first
 *    against the ones still kept.
 * 2. Containers, over the twin survivors only, so a dropped twin never adds
 *    to what a container holds: a box drops when the smaller kept boxes it
 *    holds (0.9 or more of each inside it, and it at least 1.2 times each
 *    one's area) together span 0.75 or more of its width or height. A loose
 *    box around one balloon drops for the tight one, and a box over the
 *    lobes of a split balloon drops for the lobes, which stay separate
 *    bubbles. A small balloon inside a big one's box without spanning it is
 *    a separate balloon, and both stay (the #225 inset rule). Boxes are
 *    judged largest first against the ones still kept.
 *
 * A dropped box leaves its text to its twin or to the boxes it holds. The
 * box units only need to agree with each other. Order is preserved in both
 * lists.
 */
export function filterDuplicateBubbles<T extends FilterableBubble>(
  bubbles: T[],
): { kept: T[]; dropped: T[] } {
  const dropped = new Set<T>();
  const live = (self: T) =>
    bubbles.filter((o) => o !== self && !dropped.has(o));

  const byConfidence = [...bubbles].sort((a, b) => b.confidence - a.confidence);
  for (const bubble of byConfidence) {
    // Higher-ranked boxes are judged first, so a twin still kept outranks it.
    const rank = byConfidence.indexOf(bubble);
    const isTwinLoser = live(bubble).some(
      (o) => byConfidence.indexOf(o) < rank && iou(bubble, o) >= TWIN_IOU,
    );
    if (isTwinLoser) dropped.add(bubble);
  }

  const bySize = [...bubbles].sort(
    (a, b) => area(b.bounding_box) - area(a.bounding_box),
  );
  for (const bubble of bySize) {
    if (dropped.has(bubble)) continue;
    const held = live(bubble).filter((o) => holds(bubble, o));
    const heldBoxes = held.map((o) => o.bounding_box);
    if (spansTogether(bubble.bounding_box, heldBoxes)) dropped.add(bubble);
  }
  return {
    kept: bubbles.filter((b) => !dropped.has(b)),
    dropped: bubbles.filter((b) => dropped.has(b)),
  };
}
