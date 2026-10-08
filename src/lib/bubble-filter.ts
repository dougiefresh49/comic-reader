import { area, intersectArea, type FilterablePanel } from "~/lib/panel-filter";
import type { PanelBoundingBox } from "~/types/panels";

/** Anything carrying a bubble box and its detection confidence. */
export type FilterableBubble = FilterablePanel & { confidence: number };

/** One dropped box, the rule that dropped it, and the boxes it dropped for. */
export type BubbleDrop<T> = {
  bubble: T;
  rule: "twin" | "container";
  /** The twin that outranked it, or every kept box the container holds. */
  by: T[];
  /**
   * Container drops only, true when the geometry is unsure, so the caller
   * may ask something that can see the page before dropping it: the held
   * boxes span under `UNSURE_SPAN`; or the span test counted two held
   * detections of one balloon once; or a counted box holds a box reaching
   * past the container's edge; or a counted box is in a nested pair at
   * `TWIN_IOU` or more, spared by the twin pass, with a box the container
   * does not hold. Always false for a twin.
   */
  unsure: boolean;
};

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
 * small one inside its box is not (the reviewed "DUDES…" box of
 * tmnt-mmpr-iii issue-1 page 8 around "EXACTLY!", 0.36 of its width).
 */
const HOLD_SPAN = 0.75;

/**
 * Share of the smaller box's area two held boxes must share, neither holding
 * the other, to be one balloon detected twice (#343). The span test counts
 * such a pair once, by its higher-confidence box, so two offset detections
 * of one small balloon cannot add up to a span neither reaches alone. 0.2
 * is under the 0.22 the issue's twin-inset case (two 130×20 boxes 30 px
 * apart) shares at the worst of ±5 px jitter on every edge; the most two
 * separate balloons share on the smoke page is 0.14 (the "WAIT…" lobes). Merging too
 * eagerly only keeps a container, the safe way to fail.
 */
const SAME_BALLOON_OVERLAP = 0.2;

/**
 * A container drop is unsure, and worth a look at the page (#343), when the
 * held boxes span less than this share of it, or when the span test had to
 * count a held pair once (`SAME_BALLOON_OVERLAP`), the shape of a small
 * balloon detected twice inside a bigger one, or when a counted box holds a
 * box that reaches past the container's edge, or when a counted box is in a
 * nested pair at `TWIN_IOU` or more (one the twin pass spared) with a box
 * the container does not hold. 0.85 is HOLD_SPAN plus 0.1: on
 * the smoke page every sure container drop spans 0.9 or more.
 */
const UNSURE_SPAN = 0.85;

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

const nested = (a: FilterablePanel, b: FilterablePanel) =>
  holds(a, b) || holds(b, a);

/**
 * The held boxes with each balloon detected twice counted once: highest
 * confidence first, a box is skipped when it shares `SAME_BALLOON_OVERLAP`
 * of the smaller one's area with a box already counted and neither holds
 * the other.
 */
function oneBoxPerBalloon<T extends FilterableBubble>(held: T[]): T[] {
  const counted: T[] = [];
  for (const box of [...held].sort((a, b) => b.confidence - a.confidence)) {
    const sameBalloon = counted.some(
      (c) =>
        !nested(c, box) &&
        intersectArea(c.bounding_box, box.bounding_box) >=
          SAME_BALLOON_OVERLAP *
            Math.min(area(c.bounding_box), area(box.bounding_box)),
    );
    if (!sameBalloon) counted.push(box);
  }
  return counted;
}

/**
 * The larger of the shares of `big`'s width and height that the `held`
 * boxes span together: from the leftmost (topmost) held edge to the
 * rightmost (bottommost), clipped to `big`. 0 when nothing is held.
 */
function spanShare(big: PanelBoundingBox, held: PanelBoundingBox[]): number {
  if (held.length === 0) return 0;
  const extent = (k: "x" | "y", s: "w" | "h") =>
    Math.min(big[k] + big[s], Math.max(...held.map((b) => b[k] + b[s]))) -
    Math.max(big[k], Math.min(...held.map((b) => b[k])));
  return Math.max(extent("x", "w") / big.w, extent("y", "h") / big.h);
}

/**
 * Split bubble detections into kept and dropped, one box per balloon (#311),
 * in two passes:
 *
 * 1. Twins: of two boxes at IoU 0.6 or more, the lower confidence drops (on
 *    a tie, the later box). Boxes are judged highest confidence first
 *    against the ones still kept. A pair where one box holds the other is
 *    not a twin pair whatever its IoU; the container pass settles it, so a
 *    loose box around a tight one drops for it (#343).
 * 2. Containers, over the twin survivors only, so a dropped twin never adds
 *    to what a container holds: a box drops when the smaller kept boxes it
 *    holds (0.9 or more of each inside it, and it at least 1.2 times each
 *    one's area) together span 0.75 or more of its width or height. Only
 *    the innermost held boxes count, so a loose box around a tight one adds
 *    nothing, and two held detections of one balloon count once. A loose box around
 *    one balloon drops for the tight one, and a box over the lobes of a
 *    split balloon drops for the lobes, which stay separate bubbles. A small
 *    balloon inside a big one's box without spanning it is a separate
 *    balloon, and both stay (the #225 inset rule). Boxes are judged largest
 *    first against the ones still kept.
 *
 * A twin drop leaves its text to the twin that outranked it, and is undone
 * when that twin then drops as a container, unless the twin holds the boxes
 * that container dropped for and they span it; a container drop leaves its
 * text to the boxes it holds, which are all kept when it is judged. A
 * container drop is marked `unsure` when its held boxes span under
 * `UNSURE_SPAN`, when two held detections of one balloon were counted once,
 * when a counted box holds a box reaching past its edge, or when a counted
 * box is in a nested pair the twin pass spared with a box it does not hold;
 * the filter still drops it, and the caller decides whether to look again.
 * The box units only need to agree with each other. Order is preserved in
 * `kept`, `dropped` and `drops`.
 */
export function filterDuplicateBubbles<T extends FilterableBubble>(
  bubbles: T[],
): { kept: T[]; dropped: T[]; drops: BubbleDrop<T>[] } {
  const drops = new Map<T, BubbleDrop<T>>();
  const live = (self: T) => bubbles.filter((o) => o !== self && !drops.has(o));

  const byConfidence = [...bubbles].sort((a, b) => b.confidence - a.confidence);
  for (const bubble of byConfidence) {
    // Higher-ranked boxes are judged first, so a twin still kept outranks it.
    const rank = byConfidence.indexOf(bubble);
    const twin = live(bubble).find(
      (o) =>
        byConfidence.indexOf(o) < rank &&
        !nested(bubble, o) &&
        iou(bubble, o) >= TWIN_IOU,
    );
    if (twin) {
      drops.set(bubble, { bubble, rule: "twin", by: [twin], unsure: false });
    }
  }

  const bySize = [...bubbles].sort(
    (a, b) => area(b.bounding_box) - area(a.bounding_box),
  );
  for (const bubble of bySize) {
    if (drops.has(bubble)) continue;
    const held = live(bubble).filter((o) => holds(bubble, o));
    // A held box that holds another held box is a looser box around it, not
    // more of the container's span: only the innermost boxes count.
    const innermost = held.filter((h) => !held.some((o) => holds(h, o)));
    const counted = oneBoxPerBalloon(innermost);
    const span = spanShare(
      bubble.bounding_box,
      counted.map((o) => o.bounding_box),
    );
    if (span < HOLD_SPAN) continue;
    // A counted box that holds a box the container does not (it straddles
    // the container's edge) may be a loose box, not the container's content.
    const straddles = counted.some((c) =>
      live(bubble).some((o) => o !== c && holds(c, o) && !holds(bubble, o)),
    );
    // A counted box in a nested pair the twin pass spared (IoU at TWIN_IOU
    // or more) whose other box the container does not hold: the twin test
    // would have settled that pair by confidence, so the span rests on a
    // call the pass never made.
    const sparedTwin = counted.some((c) =>
      live(bubble).some(
        (o) =>
          o !== c && nested(c, o) && iou(c, o) >= TWIN_IOU && !holds(bubble, o),
      ),
    );
    drops.set(bubble, {
      bubble,
      rule: "container",
      by: held,
      unsure:
        span < UNSURE_SPAN ||
        counted.length < innermost.length ||
        straddles ||
        sparedTwin,
    });
  }

  // A twin whose winner later dropped as a container has lost the box that
  // carried its text: keep it, unless it holds every kept box its winner
  // dropped for and those boxes span it (`UNSURE_SPAN`), so they carry its
  // text instead (a twin of a loose box over a split balloon's lobes). No
  // further judging, so it may stay as an extra box, the safe way to fail.
  const droppedNow = new Set(drops.keys());
  for (const [bubble, drop] of drops) {
    const winner = drop.rule === "twin" ? drops.get(drop.by[0]!) : undefined;
    if (!winner) continue;
    const carriers = winner.by.filter((o) => !droppedNow.has(o));
    const covered =
      carriers.length > 0 &&
      carriers.every((o) => holds(bubble, o)) &&
      spanShare(
        bubble.bounding_box,
        carriers.map((o) => o.bounding_box),
      ) >= UNSURE_SPAN;
    if (!covered) drops.delete(bubble);
  }
  return {
    kept: bubbles.filter((b) => !drops.has(b)),
    dropped: bubbles.filter((b) => drops.has(b)),
    drops: bubbles.flatMap((b) => drops.get(b) ?? []),
  };
}
