import { stripAudioTags } from "~/components/zen-comic-reader/text-utils";
import type { Box, TextGeometry } from "~/types/text-geometry";

/**
 * Line-to-bubble assignment for word boxes (#61), shared by
 * `scripts/ocr-word-geometry.ts` and the ingest step (#573). Pure: no
 * Supabase client and no filesystem; the caller loads bubbles and runs OCR.
 */

export type Line = TextGeometry["lines"][number];

/** Bubble types that get word boxes. */
export const CANDIDATE_TYPES = ["SPEECH", "NARRATION", "CAPTION"] as const;

// Constraining `Q` by Postgrest's own filter signatures hits TS2589 (type
// instantiation too deep), so the chain is typed loosely inside and the
// caller's query type comes back unchanged.
type CandidateChain = {
  eq(column: string, value: unknown): CandidateChain;
  in(column: string, values: readonly string[]): CandidateChain;
  not(column: string, operator: string, value: unknown): CandidateChain;
};

/**
 * Narrows a `bubbles` query to word-box candidates: a candidate type, not
 * ignored, with a `style` rect. The script, the step and the dashboard count
 * all filter through this, so they agree on what a candidate is.
 */
export function whereWordGeometryCandidate<
  Q extends { eq: unknown; in: unknown; not: unknown },
>(query: Q): Q {
  return (query as unknown as CandidateChain)
    .eq("ignored", false)
    .in("type", CANDIDATE_TYPES)
    .not("style", "is", null) as unknown as Q;
}

const WATERMARK = /readcomiconline|read more free comics/i;
const PAD = 0.02; // bubble rect padding, page-normalized (2% of the page)
const MIN_COVER = 0.5;

export type AssignableBubble = {
  id: string;
  style: unknown;
  text_with_cues: string | null;
  ocr_text: string | null;
};

/** The text a bubble's lines are matched against: cues first, else OCR. */
export function bubbleText(bubble: AssignableBubble): string {
  return stripAudioTags(bubble.text_with_cues ?? bubble.ocr_text ?? "");
}

/**
 * Uppercase, ’ to ', then split on every character but A-Z, 0-9 and ', so a
 * hyphen separates tokens (FLEET- / FOOTED still matches FLEET-FOOTED) and
 * DON'T stays one token. Repeated letters collapse: GRRRR and GRR are GR (#934).
 */
function tokens(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/’/g, "'")
    .replace(/([A-Z])\1+/g, "$1")
    .split(/[^A-Z0-9']+/)
    .filter((t) => /[A-Z0-9]/.test(t));
}

export function lineText(line: Line): string {
  return line.words.map((w) => w.t).join(" ");
}

function lineTokens(line: Line): string[] {
  return line.words.flatMap((w) => tokens(w.t));
}

/** `bubbles.style` page-% strings as a padded, page-normalized rect. */
function paddedRect(style: unknown): Box | null {
  if (!style || typeof style !== "object") return null;
  const s = style as Record<string, unknown>;
  const n = (k: string) =>
    typeof s[k] === "string" ? parseFloat(s[k]) / 100 : NaN;
  const [x, y, w, h] = [n("left"), n("top"), n("width"), n("height")];
  if ([x, y, w, h].some((v) => !Number.isFinite(v))) return null;
  return [x - PAD, y - PAD, w + 2 * PAD, h + 2 * PAD];
}

function contains(rect: Box, px: number, py: number): boolean {
  return (
    px >= rect[0] &&
    px <= rect[0] + rect[2] &&
    py >= rect[1] &&
    py <= rect[1] + rect[3]
  );
}

function intersection(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function sameBox(a: Box, b: Box): boolean {
  return a.every((v, i) => v === b[i]);
}

/** The box around `boxes`, rounded like the OCR boxes (4 decimals). */
function union(boxes: Box[]): Box {
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [r4(x0), r4(y0), r4(x1 - x0), r4(y1 - y0)];
}

/** `ts` as a multiset: token to count. */
function tokenPool(ts: string[]): Map<string, number> {
  const pool = new Map<string, number>();
  for (const t of ts) pool.set(t, (pool.get(t) ?? 0) + 1);
  return pool;
}

/** How many of `want` (a multiset) appear in `have`, each used once. */
function covered(want: string[], have: string[]): number {
  const pool = tokenPool(have);
  let hits = 0;
  for (const t of want) {
    const left = pool.get(t) ?? 0;
    if (left > 0) {
      hits++;
      pool.set(t, left - 1);
    }
  }
  return hits;
}

export type BubbleAssignment<B extends AssignableBubble> = {
  bubble: B;
  /** Assigned lines, top to bottom; `null` geometry when there are none. */
  geometry: TextGeometry | null;
  /** Bubble-text tokens found in the assigned lines / bubble-text tokens. */
  wordsCovered: number;
  wordsTotal: number;
};

export type PageAssignment<B extends AssignableBubble> = {
  bubbles: BubbleAssignment<B>[];
  /** Lines no bubble claimed. */
  unassigned: Line[];
  /** Download-site watermark lines, never assigned. */
  dropped: Line[];
  /** Multi-word lines whose words all repeat the line box. */
  flat: Line[];
};

/**
 * Gives each OCR line of one page to at most one of that page's bubbles: the
 * line's centre must sit in the bubble's padded rect and at least
 * `MIN_COVER` of its tokens must appear in the bubble's text; ties go to the
 * larger overlap. Watermark lines are dropped. A line no bubble claims is then
 * split word by word, each word going to a bubble whose padded rect holds its
 * centre and whose unclaimed text tokens still include all of the word's, so
 * a line Cloud Vision runs across two bubbles reaches both (#933). A word
 * with no tokens follows the word before it if its centre is in that bubble;
 * flat lines are not split. Tokens compare with repeated letters collapsed
 * (#934).
 */
export function assignLinesToBubbles<B extends AssignableBubble>(
  bubbles: B[],
  page: TextGeometry,
): PageAssignment<B> {
  const entries = bubbles.map((bubble) => ({
    bubble,
    rect: paddedRect(bubble.style),
    tokens: tokens(bubbleText(bubble)),
    lines: [] as Line[],
  }));

  const dropped: Line[] = [];
  const unassigned: Line[] = [];
  const flat: Line[] = [];
  for (const line of page.lines) {
    if (WATERMARK.test(lineText(line))) {
      dropped.push(line);
      continue;
    }
    if (
      line.words.length > 1 &&
      line.words.every((w) => sameBox(w.box, line.box))
    ) {
      flat.push(line);
    }
    const lt = lineTokens(line);
    const cx = line.box[0] + line.box[2] / 2;
    const cy = line.box[1] + line.box[3] / 2;
    let best: {
      entry: (typeof entries)[number];
      cover: number;
      area: number;
    } | null = null;
    for (const entry of entries) {
      if (!entry.rect || !lt.length || !contains(entry.rect, cx, cy)) continue;
      const cover = covered(lt, entry.tokens) / lt.length;
      if (cover < MIN_COVER) continue;
      const area = intersection(entry.rect, line.box);
      if (
        !best ||
        cover > best.cover ||
        (cover === best.cover && area > best.area)
      ) {
        best = { entry, cover, area };
      }
    }
    if (best) best.entry.lines.push(line);
    else unassigned.push(line);
  }

  // Word pass over the unclaimed lines; each bubble's pool is its text tokens
  // minus those of the lines it already holds and the words it takes here.
  type Entry = (typeof entries)[number];
  type Word = Line["words"][number];
  const pools = new Map(
    entries.map((e) => {
      const pool = tokenPool(e.tokens);
      for (const t of e.lines.flatMap(lineTokens)) {
        if (pool.get(t)) pool.set(t, pool.get(t)! - 1);
      }
      return [e, pool] as const;
    }),
  );
  const unclaimed: Line[] = [];
  for (const line of unassigned) {
    // A flat line's words all carry the line box, so they can't be split.
    if (flat.includes(line)) {
      unclaimed.push(line);
      continue;
    }
    const owners: (Entry | null)[] = [];
    for (const word of line.words) {
      const wt = tokens(word.t);
      const cx = word.box[0] + word.box[2] / 2;
      const cy = word.box[1] + word.box[3] / 2;
      if (!wt.length) {
        const prev = owners.at(-1);
        owners.push(prev?.rect && contains(prev.rect, cx, cy) ? prev : null);
        continue;
      }
      const need = [...tokenPool(wt)];
      let best: { entry: Entry; area: number } | null = null;
      for (const entry of entries) {
        const pool = pools.get(entry)!;
        if (!entry.rect || !contains(entry.rect, cx, cy)) continue;
        if (need.some(([t, n]) => (pool.get(t) ?? 0) < n)) continue;
        const area = intersection(entry.rect, word.box);
        if (!best || area > best.area) best = { entry, area };
      }
      if (best) {
        const pool = pools.get(best.entry)!;
        for (const t of wt) pool.set(t, pool.get(t)! - 1);
      }
      owners.push(best?.entry ?? null);
    }
    if (owners.every((o) => !o)) {
      unclaimed.push(line);
      continue;
    }
    const rest: Word[] = [];
    let run: Word[] = [];
    line.words.forEach((word, i) => {
      const owner = owners[i];
      if (!owner) rest.push(word);
      else run.push(word);
      if (owner && owners[i + 1] !== owner) {
        owner.lines.push({ box: union(run.map((w) => w.box)), words: run });
        run = [];
      }
    });
    if (rest.length) {
      unclaimed.push({ box: union(rest.map((w) => w.box)), words: rest });
    }
  }

  return {
    bubbles: entries.map((entry) => {
      entry.lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
      return {
        bubble: entry.bubble,
        geometry: entry.lines.length
          ? { engine: page.engine, image: page.image, lines: entry.lines }
          : null,
        wordsCovered: covered(entry.tokens, entry.lines.flatMap(lineTokens)),
        wordsTotal: entry.tokens.length,
      };
    }),
    unassigned: unclaimed,
    dropped,
    flat,
  };
}
