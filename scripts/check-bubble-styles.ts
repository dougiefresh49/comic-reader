/**
 * Read-only acceptance seam for bubble style math and the would-write filter.
 *
 * Usage: pnpm tsx --env-file=.env scripts/check-bubble-styles.ts <bookId> <issueId>
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/database";
import {
  type BubbleStyle,
  computeBubbleStyle,
  hasPixelBox2d,
  shouldWriteBubbleStyle,
} from "~/workflows/steps/bubble-style";

const bookId = process.argv[2];
const issueId = process.argv[3];

if (!bookId || !issueId) {
  console.error(
    "Usage: pnpm tsx --env-file=.env scripts/check-bubble-styles.ts <bookId> <issueId>",
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient<Database>(url, key, {
  auth: { persistSession: false },
});

function parseStyle(style: unknown): BubbleStyle | null {
  if (!style || typeof style !== "object") return null;
  const s = style as Record<string, unknown>;
  if (
    typeof s.left !== "string" ||
    typeof s.top !== "string" ||
    typeof s.width !== "string" ||
    typeof s.height !== "string"
  ) {
    return null;
  }
  return {
    left: s.left,
    top: s.top,
    width: s.width,
    height: s.height,
  };
}

function pctValue(s: string): number {
  return parseFloat(s);
}

function maxFieldDiff(a: BubbleStyle, b: BubbleStyle): number {
  const fields = ["left", "top", "width", "height"] as const;
  let max = 0;
  for (const f of fields) {
    const d = Math.abs(pctValue(a[f]) - pctValue(b[f]));
    if (d > max) max = d;
  }
  return max;
}

function stylesEqual(a: BubbleStyle, b: BubbleStyle): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

const { data: pages, error: pagesError } = await supabase
  .from("pages")
  .select("number, width, height")
  .eq("book_id", bookId)
  .eq("issue_id", issueId);

if (pagesError) {
  console.error(`pages: ${pagesError.message}`);
  process.exit(1);
}

const pageDims = new Map(
  (pages ?? []).map((p) => [p.number, { width: p.width, height: p.height }]),
);

const { data: bubbles, error: bubblesError } = await supabase
  .from("bubbles")
  .select("id, page_number, box_2d, style")
  .eq("book_id", bookId)
  .eq("issue_id", issueId);

if (bubblesError) {
  console.error(`bubbles: ${bubblesError.message}`);
  process.exit(1);
}

const rows = bubbles ?? [];
let pixelCount = 0;
let matchCount = 0;
/** Whole-hundredths rounding miss: Math.round(diff * 100) === 1. */
const roundingMisses: Array<{
  id: string;
  cents: number;
  computed: BubbleStyle;
  stored: BubbleStyle;
}> = [];
/** Real miss: Math.round(diff * 100) > 1 (or no stored style). */
const realMisses: Array<{
  id: string;
  cents: number | null;
  computed: BubbleStyle;
  stored: BubbleStyle | null;
}> = [];

for (const bubble of rows) {
  if (!hasPixelBox2d(bubble.box_2d)) continue;
  const dim = pageDims.get(bubble.page_number);
  if (!dim) continue;

  const computed = computeBubbleStyle(bubble.box_2d, dim.width, dim.height);
  if (!computed) continue;

  pixelCount++;
  const stored = parseStyle(bubble.style);
  if (stored && stylesEqual(computed, stored)) {
    matchCount++;
    continue;
  }
  if (stored) {
    const diff = maxFieldDiff(computed, stored);
    const cents = Math.round(diff * 100);
    if (cents === 0) {
      matchCount++;
    } else if (cents === 1) {
      roundingMisses.push({ id: bubble.id, cents, computed, stored });
    } else {
      realMisses.push({ id: bubble.id, cents, computed, stored });
    }
  } else {
    realMisses.push({ id: bubble.id, cents: null, computed, stored: null });
  }
}

const wouldWrite = rows.filter((b) =>
  shouldWriteBubbleStyle(b, pageDims.get(b.page_number)),
).length;

console.log(`${matchCount}/${pixelCount} match`);
console.log(`would write: ${wouldWrite}`);

if (roundingMisses.length > 0) {
  console.log(`rounding misses: ${roundingMisses.length}`);
  for (const m of roundingMisses) {
    console.log(
      `  ${m.id}: stored=${JSON.stringify(m.stored)} computed=${JSON.stringify(m.computed)}`,
    );
  }
}

if (realMisses.length > 0) {
  console.log(`real misses: ${realMisses.length}`);
  for (const m of realMisses) {
    console.log(
      `  ${m.id}: stored=${JSON.stringify(m.stored)} computed=${JSON.stringify(m.computed)}`,
    );
  }
}
