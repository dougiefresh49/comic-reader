import "server-only";
import type { ComponentProps } from "react";
import { supabase } from "~/lib/supabase";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageImageUrl } from "~/lib/storage";
import type ZenComicReader from "~/components/ZenComicReader";
import type { EndOfIssue } from "~/components/zen-comic-reader/EndOfIssueScreen";
import type { Bubble, AudioTimestamps } from "~/types";
import type { TextGeometry } from "~/types/text-geometry";
import type {
  BookManifest,
  IssueManifest,
  Manifest,
  SeriesManifest,
} from "~/types/manifest";
import {
  normalizeSpreadStarts,
  spreadPageTurns,
  spreadPagesFor,
  spreadPlane,
  toSpreadPlane,
  type ReaderSpread,
  type SpreadPage,
} from "~/lib/spreads";
import { getPanelsForPage } from "./panels";

export interface PageData {
  bubbles: Bubble[];
  timestamps: Record<string, AudioTimestamps>;
}

interface BubbleRow {
  id: string;
  ocr_text: string | null;
  text_with_cues: string | null;
  type: string;
  speaker: string | null;
  emotion: string | null;
  ai_reasoning: string | null;
  ignored: boolean | null;
  box_2d: Bubble["box_2d"] | null;
  style: Bubble["style"] | null;
  text_geometry: TextGeometry | null;
  fill_color: string | null;
  group_id: string | null;
  audio_storage_path: string | null;
  page_number: number;
  sort_order: number;
  audio_timestamps?: TimestampRow | TimestampRow[] | null;
  characters?: CharacterRow | CharacterRow[] | null;
}

/**
 * The embedded `characters` row for a bubble's `character_id`. The FK makes
 * it many-to-one, so PostgREST returns an object (or null); the array form
 * is accepted the same way as `TimestampRow`.
 */
interface CharacterRow {
  display_name: string | null;
}

/**
 * The embedded `audio_timestamps` row for a bubble. `bubble_id` is unique
 * over the FK to `bubbles`, so PostgREST returns one row, as an object. The
 * array form is accepted so a shape change reads as a missing take rather
 * than a crash.
 */
interface TimestampRow {
  alignment: AudioTimestamps["alignment"];
  normalized_alignment: AudioTimestamps["normalized_alignment"];
}

interface IssueRow {
  id: string;
  number: number;
  name: string;
  page_count: number;
  bubble_count: number;
  audio_count: number;
  has_webp: boolean;
  has_audio: boolean;
  has_timestamps: boolean;
  status: string;
}

interface BookRow {
  id: string;
  name: string;
  series_id: string | null;
  series_position: number | null;
  series: { id: string; name: string } | null;
  issues: IssueRow[] | null;
}

function rowToBubble(row: BubbleRow): Bubble {
  const character = Array.isArray(row.characters)
    ? row.characters[0]
    : row.characters;
  return {
    id: row.id,
    box_2d: row.box_2d ?? {},
    ocr_text: row.ocr_text ?? "",
    type: row.type as Bubble["type"],
    speaker: row.speaker ?? null,
    speakerName: character?.display_name ?? row.speaker ?? null,
    emotion: row.emotion ?? "",
    textWithCues: row.text_with_cues ?? undefined,
    aiReasoning: row.ai_reasoning ?? undefined,
    ignored: row.ignored ?? undefined,
    style: row.style ?? undefined,
    textGeometry: row.text_geometry ?? null,
    fillColor: row.fill_color ?? null,
    groupId: row.group_id ?? null,
    sortOrder: row.sort_order,
    audioStoragePath: row.audio_storage_path ?? undefined,
  };
}

/**
 * Fetches page data including bubbles and audio timestamps for a given comic page
 *
 * The timestamps come back embedded on the bubble row, so one statement
 * answers both. A second read could land after a regenerate swapped the
 * audio path and paired one take's path with another's word timings.
 */
export async function getPageData(
  bookId: string,
  issueId: string,
  pageNumber: string,
): Promise<PageData> {
  const pageNum = parseInt(pageNumber, 10);
  if (Number.isNaN(pageNum)) {
    return { bubbles: [], timestamps: {} };
  }

  const { data: bubbleRows, error: bubbleError } = await supabase
    .from("bubbles")
    .select(
      "id, ocr_text, text_with_cues, type, speaker, emotion, ai_reasoning, ignored, box_2d, style, text_geometry, fill_color, group_id, audio_storage_path, page_number, sort_order, audio_timestamps(alignment, normalized_alignment), characters(display_name)",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("page_number", pageNum)
    .order("sort_order");

  if (bubbleError) {
    console.error("getPageData:", bubbleError);
    throw new Error(`getPageData: ${bubbleError.message}`, {
      cause: bubbleError,
    });
  }

  const rows = (bubbleRows ?? []) as BubbleRow[];

  const timestamps: Record<string, AudioTimestamps> = {};
  for (const row of rows) {
    const embedded = row.audio_timestamps;
    if (!embedded) continue;
    const ts = Array.isArray(embedded) ? embedded[0] : embedded;
    if (!ts) continue;
    timestamps[row.id] = {
      alignment: ts.alignment ?? null,
      normalized_alignment: ts.normalized_alignment ?? null,
    };
  }

  return {
    bubbles: rows.map(rowToBubble),
    timestamps,
  };
}

/**
 * Every book with its issues. Public routes pass `publishedOnly: true` so a
 * draft book stays out of the library and 404s on `/book/...`, and so does
 * an issue still at `status = 'pending'`: the pipeline sets `ready` only
 * when it finishes, and a pending issue may hold pages nobody has reviewed
 * (#374). The default keeps both; its one caller is the episode-render
 * page. The admin preview route reaches this through `getReaderPage`, which
 * passes `publishedOnly` itself.
 */
export async function getManifest({
  publishedOnly = false,
}: { publishedOnly?: boolean } = {}): Promise<Manifest> {
  let query = supabase
    .from("books")
    .select(
      "id, name, series_id, series_position, series(id, name), issues(id, number, name, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps, status)",
    )
    .order("number", { ascending: true, foreignTable: "issues" });
  if (publishedOnly) {
    query = query.eq("published", true).neq("issues.status", "pending");
  }

  const { data, error } = await query;

  if (error) {
    console.error("getManifest:", error);
    throw new Error(`getManifest: ${error.message}`, { cause: error });
  }

  const books: BookManifest[] = ((data ?? []) as unknown as BookRow[]).map(
    (book) => ({
      id: book.id,
      name: book.name,
      series: book.series
        ? {
            id: book.series.id,
            name: book.series.name,
            position: book.series_position,
          }
        : null,
      issues: (book.issues ?? []).map((issue) => ({
        id: issue.id,
        number: issue.number,
        name: issue.name,
        pageCount: issue.page_count,
        bubbleCount: issue.bubble_count,
        audioCount: issue.audio_count,
        hasWebP: issue.has_webp,
        hasAudio: issue.has_audio,
        hasTimestamps: issue.has_timestamps,
        status: issue.status,
      })),
    }),
  );

  return {
    books,
    series: groupSeries(books),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The series among `books`, in the order each one's first book appears, with
 * its books by `position` ascending (nulls last), then by book id. Built from
 * the books the caller already filtered, so with `publishedOnly` a series
 * with no published book is absent.
 */
function groupSeries(books: BookManifest[]): SeriesManifest[] {
  const byId = new Map<string, SeriesManifest>();
  for (const book of books) {
    if (!book.series) continue;
    let entry = byId.get(book.series.id);
    if (!entry) {
      entry = { id: book.series.id, name: book.series.name, books: [] };
      byId.set(entry.id, entry);
    }
    entry.books.push(book);
  }
  for (const entry of byId.values()) {
    entry.books.sort((a, z) => {
      const ap = a.series?.position ?? null;
      const zp = z.series?.position ?? null;
      if (ap !== zp) {
        if (ap === null) return 1;
        if (zp === null) return -1;
        return ap - zp;
      }
      return a.id < z.id ? -1 : a.id > z.id ? 1 : 0;
    });
  }
  return [...byId.values()];
}

/**
 * `books.published` keyed by book id, for the admin book list. The list reads
 * its books from `getAdminBooks`, which is a different shape, so
 * this is a second small read rather than a change to that query.
 */
export async function getBookPublishedFlags(): Promise<
  Record<string, boolean>
> {
  const { data, error } = await supabaseAdmin
    .from("books")
    .select("id, published");
  if (error) {
    console.error("getBookPublishedFlags:", error);
    throw new Error(`getBookPublishedFlags: ${error.message}`, {
      cause: error,
    });
  }
  return Object.fromEntries(
    ((data ?? []) as Array<{ id: string; published: boolean | null }>).map(
      (row) => [row.id, row.published ?? false],
    ),
  );
}

/**
 * The highest page number stored per issue, for every book, as
 * `{ bookId: { issueId: pageCount } }`.
 *
 * `issues.page_count` is written only by the pipeline's publishing step, so a
 * book whose pages were uploaded but not yet processed reports zero and its
 * reader would 404 on page 1. The `pages` table carries one row per stored
 * image and the upload path writes it, so it is the honest count in that
 * window.
 *
 * Asked for one book at a time, descending, one row per issue: PostgREST
 * caps a response at the project's max-rows setting (1,000 here), and an
 * unpaginated read of the whole table would silently drop pages past that
 * and report a short issue as having none. Ascending by number means the
 * first row seen for an issue is its highest, so one row per issue is
 * enough and a truncated response can only under-report, never overstate.
 * The service-role client is used because the anon key cannot read `pages`.
 */
export async function getStoredPageCounts(
  bookId?: string,
): Promise<Record<string, Record<string, number>>> {
  const byBook: Record<string, Record<string, number>> = {};
  let from = 0;
  const pageSize = 1000;

  for (;;) {
    let query = supabaseAdmin
      .from("pages")
      .select("book_id, issue_id, number")
      .order("number", { ascending: false })
      .order("book_id", { ascending: true })
      .order("issue_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (bookId) query = query.eq("book_id", bookId);

    const { data, error } = await query;
    if (error) {
      console.error("getStoredPageCounts:", error);
      throw new Error(`getStoredPageCounts: ${error.message}`, {
        cause: error,
      });
    }

    for (const row of (data ?? []) as Array<{
      book_id: string;
      issue_id: string;
      number: number;
    }>) {
      const issues = (byBook[row.book_id] ??= {});
      issues[row.issue_id] ??= row.number;
    }

    if (!data || data.length < pageSize) return byBook;
    from += pageSize;
  }
}

/** The pages an issue has: its manifest count, or the stored count if that is 0. */
function pageCountFor(
  bookId: string,
  issueId: string,
  manifestCount: number,
  stored: Record<string, Record<string, number>>,
): number {
  if (manifestCount > 0) return manifestCount;
  return stored[bookId]?.[issueId] ?? 0;
}

export type ReaderPageProps = ComponentProps<typeof ZenComicReader>;

/** "Issue 2", plus the issue's name when it says more than that. */
function issueLinkLabel(issue: IssueManifest): string {
  const base = `Issue ${issue.number}`;
  const name = issue.name.trim();
  return name && name.toLowerCase() !== base.toLowerCase()
    ? `${base} · ${name}`
    : base;
}

/**
 * Where the end-of-issue screen leads (#830), from the manifest already
 * loaded. Next issue: the first later issue of this book that has pages.
 * Next book, only without a next issue: the first later book in the series
 * whose first issue has pages. On the public route the issue must also be
 * `ready`: the manifest's `publishedOnly` filter drops draft books and
 * pending issues but keeps `processing` ones.
 */
function endOfIssueLinks(
  manifest: Manifest,
  book: BookManifest,
  issueId: string,
  storedCounts: Record<string, Record<string, number>>,
  basePath: "/book" | "/admin/preview",
): EndOfIssue {
  // The public reader offers only finished issues; preview offers any.
  const finished = (i: IssueManifest) =>
    basePath === "/admin/preview" || i.status === "ready";
  const at = book.issues.findIndex((i) => i.id === issueId);
  const nextIssue = book.issues
    .slice(at + 1)
    .find(
      (i) =>
        finished(i) &&
        pageCountFor(book.id, i.id, i.pageCount, storedCounts) > 0,
    );
  if (nextIssue) {
    return {
      nextIssue: {
        href: `${basePath}/${book.id}/${nextIssue.id}/1`,
        label: issueLinkLabel(nextIssue),
      },
      nextBook: null,
      libraryHref: "/",
    };
  }

  const series = book.series
    ? manifest.series.find((s) => s.id === book.series?.id)
    : undefined;
  const books = series?.books ?? [];
  const nextBook = books
    .slice(books.findIndex((b) => b.id === book.id) + 1)
    .find((b) => {
      const first = b.issues[0];
      return !!first && finished(first) && first.pageCount > 0;
    });
  const firstIssue = nextBook?.issues[0];
  return {
    nextIssue: null,
    nextBook:
      nextBook && firstIssue
        ? {
            href: `${basePath}/${nextBook.id}/${firstIssue.id}/1`,
            label: nextBook.name,
          }
        : null,
    libraryHref: "/",
  };
}

interface SpreadPageRow {
  number: number;
  width: number;
  height: number;
  spread_with_next: boolean;
}

/**
 * The `pages` rows a reader page needs for spreads (#724), in one read:
 * every page of the issue flagged `spread_with_next`, plus `pageNum` and its
 * two neighbours, whose sizes place the halves of a spread `pageNum` is in.
 * Service-role client, because the anon key cannot read `pages`.
 */
async function getSpreadRows(
  bookId: string,
  issueId: string,
  pageNum: number,
): Promise<SpreadPageRow[]> {
  const { data, error } = await supabaseAdmin
    .from("pages")
    .select("number, width, height, spread_with_next")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .or(
      `spread_with_next.eq.true,number.in.(${pageNum - 1},${pageNum},${pageNum + 1})`,
    );
  if (error) {
    console.error("getSpreadRows:", error);
    throw new Error(`getSpreadRows: ${error.message}`, { cause: error });
  }
  return (data ?? []) as SpreadPageRow[];
}

/**
 * Everything the reader needs for one page, or null when the book, the
 * issue or the page does not exist (or the book is a draft and
 * `publishedOnly` is set). `basePath` roots the prev and next links, so the
 * admin preview keeps its readers on `/admin/preview`.
 *
 * A page in a spread (#724) comes back as the whole spread: `spread` holds
 * both images and sizes, and `bubbles` and `panels` are both pages' rows on
 * the spread plane (`~/lib/spreads`). The prev and next links step over the
 * spread as one stop. Other pages come back as before, with `spread` null.
 */
export async function getReaderPage({
  bookId,
  issueId,
  pageNumber,
  publishedOnly,
  basePath,
}: {
  bookId: string;
  issueId: string;
  pageNumber: string;
  publishedOnly: boolean;
  basePath: "/book" | "/admin/preview";
}): Promise<ReaderPageProps | null> {
  const manifest = await getManifest({ publishedOnly });
  const book = manifest.books.find((b) => b.id === bookId);
  const issue = book?.issues.find((i) => i.id === issueId);
  if (!book || !issue) return null;

  const pageNum = parseInt(pageNumber, 10);
  if (isNaN(pageNum) || pageNum < 1) return null;

  const [storedCounts, spreadRows] = await Promise.all([
    getStoredPageCounts(bookId),
    getSpreadRows(bookId, issueId, pageNum),
  ]);
  const pageCount = pageCountFor(
    bookId,
    issueId,
    issue.pageCount,
    storedCounts,
  );
  if (pageNum > pageCount) return null;

  const spreadStarts = normalizeSpreadStarts(
    spreadRows.filter((r) => r.spread_with_next).map((r) => r.number),
    pageCount,
  );
  const halves = spreadPagesFor(pageNum, spreadStarts);
  const pageLink = (n: number) => `${basePath}/${bookId}/${issueId}/${n}`;
  const turns = spreadPageTurns(pageNum, spreadStarts, pageCount);
  const common = {
    pageImage: pageImageUrl(bookId, issueId, pageNum),
    bookId,
    issueId,
    bookName: book.name,
    issueNumber: issue.number,
    pageNumber: pageNum,
    pageCount,
    prevPageLink: turns.prev !== null ? pageLink(turns.prev) : null,
    nextPageLink: turns.next !== null ? pageLink(turns.next) : null,
    // Only on the issue's last stop, where a forward turn opens the screen.
    endOfIssue:
      turns.next === null
        ? endOfIssueLinks(manifest, book, issueId, storedCounts, basePath)
        : null,
    spreadStarts,
  };

  if (!halves) {
    const [{ bubbles, timestamps }, panels] = await Promise.all([
      getPageData(bookId, issueId, pageNumber),
      getPanelsForPage(bookId, issueId, pageNum),
    ]);
    return { ...common, bubbles, timestamps, panels, spread: null };
  }

  const half = (n: number): SpreadPage => {
    const row = spreadRows.find((r) => r.number === n);
    // A missing size falls back to the 2:3 page every reader frame assumes.
    const ok = row && row.width > 0 && row.height > 0;
    return {
      pageNumber: n,
      image: pageImageUrl(bookId, issueId, n),
      width: ok ? row.width : 2,
      height: ok ? row.height : 3,
    };
  };
  const left = half(halves.left);
  const right = half(halves.right);
  const plane = spreadPlane(left, right);

  const [leftData, rightData, leftPanels, rightPanels] = await Promise.all([
    getPageData(bookId, issueId, String(left.pageNumber)),
    getPageData(bookId, issueId, String(right.pageNumber)),
    getPanelsForPage(bookId, issueId, left.pageNumber),
    getPanelsForPage(bookId, issueId, right.pageNumber),
  ]);
  const { bubbles, panels } = toSpreadPlane(
    plane,
    { bubbles: leftData.bubbles, panels: leftPanels },
    { bubbles: rightData.bubbles, panels: rightPanels },
  );
  const spread: ReaderSpread = { left, right, ...plane };

  return {
    ...common,
    bubbles,
    // Keyed by bubble id, so the two pages' entries never collide.
    timestamps: { ...leftData.timestamps, ...rightData.timestamps },
    panels,
    spread,
  };
}
