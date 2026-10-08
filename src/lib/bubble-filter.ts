import { area, intersectArea, type FilterablePanel } from "~/lib/panel-filter";

/** Anything carrying a bubble box and its detection confidence. */
export type FilterableBubble = FilterablePanel & { confidence: number };

/** One dropped box, the rule that dropped it, and the boxes it dropped for. */
export type BubbleDrop<T> = {
  bubble: T;
  rule: "nested" | "twin" | "container";
  /**
   * The live boxes it holds at `TWIN_IOU` (nested), the twin that outranked
   * it, or every live box the container holds.
   */
  by: T[];
  /**
   * True when the geometry is unsure, so the caller may ask something that
   * can see the page before dropping it. Judged after every pass over the
   * kept boxes it holds (#652), and for a container at its turn too, over the
   * live boxes it holds: innermost only, two detections of one balloon counted
   * once. Unsure when those span under `UNSURE_SPAN` of it, when two were
   * counted once, when a counted box holds a box this one does not, twin
   * drops aside (it straddles the edge), or when a counted box (for a
   * nested drop, also one in `by`) is the inner box of another nested drop
   * not nested with this one (#343 review cases 4 and 5). A twin whose
   * winner is kept is sure; one whose winner dropped is also unsure unless
   * the winner's kept `by` boxes are all held and span `UNSURE_SPAN` of it.
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
 * A drop whose kept, counted boxes span less than this share of it is
 * unsure, and worth a look at the page (#343; every reason is listed on
 * `BubbleDrop.unsure`). 0.85 is HOLD_SPAN plus 0.1: on the smoke page
 * every sure container drop spans 0.9 or more.
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
 * The larger of the shares of `outer`'s width and height that the `inner`
 * boxes span together: from the leftmost (topmost) inner edge to the
 * rightmost (bottommost), clipped to `outer`. 0 when `inner` is empty.
 */
function spanShare(outer: FilterablePanel, inner: FilterablePanel[]) {
  if (inner.length === 0) return 0;
  const big = outer.bounding_box;
  const held = inner.map((o) => o.bounding_box);
  const extent = (k: "x" | "y", s: "w" | "h") =>
    Math.min(big[k] + big[s], Math.max(...held.map((b) => b[k] + b[s]))) -
    Math.max(big[k], Math.min(...held.map((b) => b[k])));
  return Math.max(extent("x", "w") / big.w, extent("y", "h") / big.h);
}

/**
 * Split bubble detections into kept and dropped, one box per balloon (#311),
 * in three passes:
 *
 * 1. Nested twins (#652): a box drops when it holds a box still kept at IoU
 *    0.6 or more, so a loose box around a tight one drops for it whatever
 *    their confidences (#343), before it can act on any other box. Boxes are
 *    judged smallest first, so a loose box around another loose box (#343's
 *    Z around X around Y) is judged against what is left of it.
 * 2. Twins: of two live boxes at IoU 0.6 or more, the lower confidence drops
 *    (on a tie, the later box). Boxes are judged highest confidence first
 *    against the ones still kept.
 * 3. Containers, over the survivors only, so a dropped box never adds to
 *    what a container holds: a box drops when the smaller kept boxes it
 *    holds (0.9 or more of each inside it, and it at least 1.2 times each
 *    one's area) together span 0.75 or more of its width or height. Only
 *    the innermost held boxes count, so a loose box around a tight one adds
 *    nothing, and two held detections of one balloon count once. A box over
 *    the lobes of a split balloon drops for the lobes, which stay separate
 *    bubbles. A small balloon inside a big one's box without spanning it is
 *    a separate balloon, and both stay (the #225 inset rule). Boxes are
 *    judged largest first against the ones still kept.
 *
 * A drop leaves its text to the boxes it drops for, all kept when it is
 * judged, though some may drop later; `unsure` is judged after the passes,
 * against the boxes that stay. A drop marked `unsure` is still dropped, and
 * the caller decides whether to look again. The box units only need to
 * agree with each other. Order is preserved in `kept`, `dropped` and
 * `drops`.
 */
export function filterDuplicateBubbles<T extends FilterableBubble>(
  bubbles: T[],
): { kept: T[]; dropped: T[]; drops: BubbleDrop<T>[] } {
  const drops = new Map<T, BubbleDrop<T>>();
  const live = (self: T) => bubbles.filter((o) => o !== self && !drops.has(o));
  const bySize = [...bubbles].sort(
    (a, b) => area(b.bounding_box) - area(a.bounding_box),
  );

  for (const bubble of [...bySize].reverse()) {
    const inner = live(bubble).filter(
      (o) => holds(bubble, o) && iou(bubble, o) >= TWIN_IOU,
    );
    if (inner.length > 0) {
      drops.set(bubble, { bubble, rule: "nested", by: inner, unsure: false });
    }
  }
  // An inner box of two nested drops whose outer boxes are not nested in
  // each other is disputed: the loose boxes disagree about its balloon.
  const nestedDrops = [...drops.values()];
  const disputed = (dropping: T, inner: T[]) =>
    inner.some((c) =>
      nestedDrops.some(
        (d) =>
          d.bubble !== dropping &&
          d.by.includes(c) &&
          !nested(d.bubble, dropping),
      ),
    );
  // A held box that holds another held box is a looser box around it, not
  // more of the dropping box's span: only the innermost boxes count.
  const judge = (bubble: T, held: T[]) => {
    const innermost = held.filter((h) => !held.some((o) => holds(h, o)));
    const counted = oneBoxPerBalloon(innermost);
    const span = spanShare(bubble, counted);
    // A counted box holding a box the dropping box does not (it straddles
    // the edge) may be a loose box, not the dropping box's content.
    const straddles = counted.some((c) =>
      bubbles.some(
        (o) =>
          drops.get(o)?.rule !== "twin" && holds(c, o) && !holds(bubble, o),
      ),
    );
    const unsure =
      span < UNSURE_SPAN ||
      counted.length < innermost.length ||
      disputed(bubble, counted) ||
      straddles;
    return { span, unsure };
  };

  const byConfidence = [...bubbles].sort((a, b) => b.confidence - a.confidence);
  for (const bubble of byConfidence) {
    if (drops.has(bubble)) continue;
    // Higher-ranked boxes are judged first, so a twin still kept outranks it.
    const rank = byConfidence.indexOf(bubble);
    const twin = live(bubble).find(
      (o) => byConfidence.indexOf(o) < rank && iou(bubble, o) >= TWIN_IOU,
    );
    if (twin) {
      drops.set(bubble, { bubble, rule: "twin", by: [twin], unsure: false });
    }
  }

  for (const bubble of bySize) {
    if (drops.has(bubble)) continue;
    const held = live(bubble).filter((o) => holds(bubble, o));
    const { span, unsure } = judge(bubble, held);
    if (span < HOLD_SPAN) continue;
    drops.set(bubble, { bubble, rule: "container", by: held, unsure });
  }

  // Unsure is judged again against the boxes that stay, since a box a drop
  // held may have dropped since. A twin whose winner stays is sure; one whose
  // winner dropped is also unsure unless the kept boxes that winner dropped
  // for are all held and span it (`UNSURE_SPAN`), #642's test for keeping it.
  const kept = bubbles.filter((b) => !drops.has(b));
  for (const drop of drops.values()) {
    const winner = drop.rule === "twin" ? drops.get(drop.by[0]!) : undefined;
    if (drop.rule === "twin" && !winner) continue;
    const held = kept.filter((o) => holds(drop.bubble, o));
    const carriers = winner?.by.filter((o) => !drops.has(o)) ?? [];
    drop.unsure ||=
      judge(drop.bubble, held).unsure ||
      (drop.rule === "nested" && disputed(drop.bubble, drop.by)) ||
      (!!winner &&
        (carriers.some((o) => !holds(drop.bubble, o)) ||
          spanShare(drop.bubble, carriers) < UNSURE_SPAN));
  }
  return {
    kept,
    dropped: bubbles.filter((b) => drops.has(b)),
    drops: bubbles.flatMap((b) => drops.get(b) ?? []),
  };
}
