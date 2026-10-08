import { FatalError } from "workflow";
import { pageStoragePath } from "~/lib/storage";

/** Width in px of the strip read from each page edge. */
const STRIP_PX = 6;
/** Rows each strip is resampled to, so pages of any height compare row by row. */
const ROWS = 1000;
/** Largest vertical offset, in resampled rows, tried between the two strips. */
const MAX_SHIFT = 15;
/** A pair is a spread only when the mean RGB difference is under this. */
const MAX_DIFF = 25;
/** ... and the brightness correlation is over this. */
const MIN_CORRELATION = 0.8;
/** An edge whose brightness varies less than this (std dev, 0-255) is a plain margin: blank. */
const BLANK_STD = 8;
/** Heights match when they differ by at most this fraction of the taller page. */
const HEIGHT_TOLERANCE = 0.01;

export interface EdgeComparison {
  /** Mean absolute RGB difference (0-255) at the best shift; null when skipped. */
  meanRgbDiff: number | null;
  /** Pearson correlation of the two brightness profiles at that shift; null when skipped. */
  correlation: number | null;
  flagged: boolean;
  /** Why the pair was not scored: a blank edge or heights that differ. */
  skip: string | null;
}

/** One RGB triple per resampled row: the strip averaged across its width. */
async function edgeProfile(
  image: Buffer,
  side: "left" | "right",
): Promise<{ rgb: Float64Array; height: number }> {
  // Imported here, not at the top: the workflow bundle loads this module and
  // must not reference a Node.js package outside a step.
  const { default: sharp } = await import("sharp");
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < STRIP_PX || height < 2)
    throw new Error(`image too small (${width}x${height})`);
  const { data, info } = await sharp(image)
    .extract({
      left: side === "left" ? 0 : width - STRIP_PX,
      top: 0,
      width: STRIP_PX,
      height,
    })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const rows = new Float64Array(height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < STRIP_PX; x++) {
      const i = (y * STRIP_PX + x) * ch;
      for (let c = 0; c < 3; c++) rows[y * 3 + c]! += data[i + c]! / STRIP_PX;
    }
  }
  // Linear resample to ROWS rows.
  const rgb = new Float64Array(ROWS * 3);
  for (let r = 0; r < ROWS; r++) {
    const pos = (r * (height - 1)) / (ROWS - 1);
    const y0 = Math.floor(pos);
    const y1 = Math.min(y0 + 1, height - 1);
    const t = pos - y0;
    for (let c = 0; c < 3; c++)
      rgb[r * 3 + c] = rows[y0 * 3 + c]! * (1 - t) + rows[y1 * 3 + c]! * t;
  }
  return { rgb, height };
}

function brightness(rgb: Float64Array): Float64Array {
  const out = new Float64Array(rgb.length / 3);
  for (let r = 0; r < out.length; r++)
    out[r] =
      0.299 * rgb[r * 3]! + 0.587 * rgb[r * 3 + 1]! + 0.114 * rgb[r * 3 + 2]!;
  return out;
}

function std(values: Float64Array): number {
  let mean = 0;
  for (const v of values) mean += v / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return Math.sqrt(sq / values.length);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/**
 * Spreads (#723): does the art on the right edge of `left` (page N) run on
 * into the left edge of `right` (page N+1)? Reads a 6 px strip from each
 * edge, averages it across its width, resamples it to 1000 rows and tries
 * shifts of up to ±15 rows; the shift with the smallest mean RGB difference
 * wins, and the brightness correlation is read at that shift. Flagged when
 * neither edge is blank, the heights match, the difference is under 25 and
 * the correlation is over 0.8. No I/O beyond decoding the two images; throws
 * when one cannot be decoded.
 */
export async function compareSpreadEdges(
  left: Buffer,
  right: Buffer,
): Promise<EdgeComparison> {
  const [a, b] = await Promise.all([
    edgeProfile(left, "right"),
    edgeProfile(right, "left"),
  ]);
  const unscored = (skip: string): EdgeComparison => ({
    meanRgbDiff: null,
    correlation: null,
    flagged: false,
    skip,
  });
  const taller = Math.max(a.height, b.height);
  if (Math.abs(a.height - b.height) > taller * HEIGHT_TOLERANCE)
    return unscored(`heights differ (${a.height} vs ${b.height})`);
  const ya = brightness(a.rgb);
  const yb = brightness(b.rgb);
  const blankA = std(ya) < BLANK_STD;
  const blankB = std(yb) < BLANK_STD;
  if (blankA || blankB)
    return unscored(
      `blank edge (${[blankA ? "left page" : null, blankB ? "right page" : null].filter(Boolean).join(", ")})`,
    );

  let best = { diff: Infinity, shift: 0 };
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, -s); i < ROWS && i + s < ROWS; i++) {
      for (let c = 0; c < 3; c++)
        sum += Math.abs(a.rgb[i * 3 + c]! - b.rgb[(i + s) * 3 + c]!);
      n += 3;
    }
    const diff = sum / n;
    if (diff < best.diff) best = { diff, shift: s };
  }
  const pa: number[] = [];
  const pb: number[] = [];
  for (
    let i = Math.max(0, -best.shift);
    i < ROWS && i + best.shift < ROWS;
    i++
  ) {
    pa.push(ya[i]!);
    pb.push(yb[i + best.shift]!);
  }
  const correlation = pearson(pa, pb);
  return {
    meanRgbDiff: best.diff,
    correlation,
    flagged: best.diff < MAX_DIFF && correlation > MIN_CORRELATION,
    skip: null,
  };
}

/**
 * A Postgres or PostgREST code is a data error a retry won't cure; no code
 * (a dropped connection) or PGRST0xx is transient, so the Workflow retries.
 */
function dbError(label: string, error: { message: string; code?: string }) {
  const message = `${label}: ${error.message}`;
  const transient = !error.code || error.code.startsWith("PGRST0");
  return transient ? new Error(message) : new FatalError(message);
}

/**
 * The `detect-spreads` step (#723): run `compareSpreadEdges` on every pair of
 * adjacent pages and set `spread_with_next = true` on the left page of each
 * flagged pair. It never writes false, so a pair joined by hand stays joined.
 * A pair is skipped when the left page is approved (`reviewed_at` set), or
 * when page N-1 or page N+1 already has the flag, so no page is part of two
 * spreads. A page image that cannot be read logs a warning and skips the
 * pair; only a failed DB write fails the step. Free: no model call.
 */
export async function detectSpreads(bookId: string, issueId: string) {
  "use step";
  const { createTypedStepClient } = await import("../step-utils");
  const supabase = await createTypedStepClient();
  const where = `${bookId}/${issueId}`;

  const { data: rows, error } = await supabase
    .from("pages")
    .select("number, reviewed_at, spread_with_next")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("number");
  if (error) throw dbError(`pages ${where}`, error);
  const pages = rows ?? [];
  const joined = new Set(
    pages.filter((p) => p.spread_with_next).map((p) => p.number),
  );

  const images = new Map<number, Buffer | null>();
  const image = async (n: number): Promise<Buffer | null> => {
    const cached = images.get(n);
    if (cached !== undefined) return cached;
    const { data, error: dlErr } = await supabase.storage
      .from("comic-pages")
      .download(pageStoragePath(bookId, issueId, n));
    const buf = dlErr || !data ? null : Buffer.from(await data.arrayBuffer());
    if (!buf)
      console.warn(
        `[detect-spreads] ${where}: page ${n} image unreadable (${dlErr?.message ?? "no data"})`,
      );
    images.set(n, buf);
    return buf;
  };

  let pairs = 0;
  let flagged = 0;
  for (let i = 0; i + 1 < pages.length; i++) {
    const left = pages[i]!;
    const n = left.number;
    images.delete(n - 1);
    if (pages[i + 1]!.number !== n + 1) continue;
    if (left.spread_with_next || left.reviewed_at) continue;
    if (joined.has(n - 1) || joined.has(n + 1)) continue;
    const a = await image(n);
    const b = await image(n + 1);
    if (!a || !b) continue;
    let verdict: EdgeComparison;
    try {
      verdict = await compareSpreadEdges(a, b);
    } catch (e) {
      console.warn(
        `[detect-spreads] ${where}: pages ${n}-${n + 1} not compared (${(e as Error).message})`,
      );
      continue;
    }
    pairs++;
    if (!verdict.flagged) continue;
    const { data: written, error: writeError } = await supabase
      .from("pages")
      .update({ spread_with_next: true })
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("number", n)
      .select("number");
    if (writeError) throw dbError(`page ${n} ${where}`, writeError);
    if (!written || written.length === 0)
      throw new FatalError(`page ${n} ${where}: no pages row to flag`);
    joined.add(n);
    flagged++;
    console.log(
      `[detect-spreads] ${where}: pages ${n}-${n + 1} flagged (difference ${verdict.meanRgbDiff?.toFixed(1)}, correlation ${verdict.correlation?.toFixed(2)})`,
    );
  }

  console.log(
    `[detect-spreads] ${where}: ${pages.length} pages, ${pairs} pairs compared, ${flagged} flagged`,
  );
  return { pages: pages.length, pairs, flagged };
}
