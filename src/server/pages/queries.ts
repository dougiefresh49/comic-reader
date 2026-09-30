import "server-only";
import type { ComponentProps } from "react";
import { supabase } from "~/lib/supabase";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { pageImageUrl } from "~/lib/storage";
import type ZenComicReader from "~/components/ZenComicReader";
import type { Bubble, AudioTimestamps } from "~/types";
import type { BookManifest, Manifest } from "~/types/manifest";
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
  audio_storage_path: string | null;
  page_number: number;
  sort_order: number;
  audio_timestamps?: TimestampRow | TimestampRow[] | null;
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
}

interface BookRow {
  id: string;
  name: string;
  issues: IssueRow[] | null;
}

function rowToBubble(row: BubbleRow): Bubble {
  return {
    id: row.id,
    box_2d: row.box_2d ?? {},
    ocr_text: row.ocr_text ?? "",
    type: row.type as Bubble["type"],
    speaker: row.speaker ?? null,
    emotion: row.emotion ?? "",
    textWithCues: row.text_with_cues ?? undefined,
    aiReasoning: row.ai_reasoning ?? undefined,
    ignored: row.ignored ?? undefined,
    style: row.style ?? undefined,
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

  try {
    const { data: bubbleRows, error: bubbleError } = await supabase
      .from("bubbles")
      .select(
        "id, ocr_text, text_with_cues, type, speaker, emotion, ai_reasoning, ignored, box_2d, style, audio_storage_path, page_number, sort_order, audio_timestamps(alignment, normalized_alignment)",
      )
      .eq("book_id", bookId)
      .eq("issue_id", issueId)
      .eq("page_number", pageNum)
      .order("sort_order");

    if (bubbleError) {
      console.error("getPageData bubbles:", bubbleError);
      return { bubbles: [], timestamps: {} };
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
  } catch (error) {
    console.error("Error fetching page data:", error);
    return { bubbles: [], timestamps: {} };
  }
}

export interface IssueData {
  allBubbles: Record<string, Bubble[]>;
  characters: string[];
}

export async function getIssueData(
  bookId: string,
  issueId: string,
): Promise<IssueData> {
  const { data: bubbleRows, error: bubbleError } = await supabase
    .from("bubbles")
    .select(
      "id, ocr_text, text_with_cues, type, speaker, emotion, ai_reasoning, ignored, box_2d, style, audio_storage_path, page_number, sort_order",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("page_number")
    .order("sort_order");

  if (bubbleError) {
    console.error("getIssueData bubbles:", bubbleError);
    return { allBubbles: {}, characters: [] };
  }

  const allBubbles: Record<string, Bubble[]> = {};
  for (const row of (bubbleRows ?? []) as BubbleRow[]) {
    const key = `page-${String(row.page_number).padStart(2, "0")}.jpg`;
    allBubbles[key] ??= [];
    allBubbles[key].push(rowToBubble(row));
  }

  const { data: castRows, error: castError } = await supabase
    .from("castlist")
    .select("character")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  let characters: string[] = [];
  if (!castError && castRows?.length) {
    characters = (castRows as { character: string }[])
      .map((r) => r.character)
      .sort();
  } else {
    if (castError) console.error("getIssueData castlist:", castError);
    const seen = new Set<string>();
    for (const bubbles of Object.values(allBubbles)) {
      for (const b of bubbles) {
        if (b.speaker) seen.add(b.speaker);
      }
    }
    characters = Array.from(seen).sort();
  }

  return { allBubbles, characters };
}

/**
 * Every book with its issues. Public routes pass `publishedOnly: true` so a
 * draft book stays out of the library and 404s on `/book/...`. The default
 * keeps drafts because the admin callers (the review editor, the preview
 * route) need them.
 */
export async function getManifest({
  publishedOnly = false,
}: { publishedOnly?: boolean } = {}): Promise<Manifest> {
  let query = supabase
    .from("books")
    .select(
      "id, name, issues(id, number, name, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps)",
    )
    .order("number", { ascending: true, foreignTable: "issues" });
  if (publishedOnly) query = query.eq("published", true);

  const { data, error } = await query;

  if (error) {
    console.error("getManifest:", error);
    return { books: [], generatedAt: new Date().toISOString() };
  }

  const books: BookManifest[] = ((data ?? []) as BookRow[]).map((book) => ({
    id: book.id,
    name: book.name,
    issues: (book.issues ?? []).map((issue) => ({
      id: issue.id,
      name: issue.name,
      pageCount: issue.page_count,
      bubbleCount: issue.bubble_count,
      audioCount: issue.audio_count,
      hasWebP: issue.has_webp,
      hasAudio: issue.has_audio,
      hasTimestamps: issue.has_timestamps,
    })),
  }));

  return {
    books,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * `books.published` keyed by book id, for the admin book list. The list reads
 * its books from `getAdminBooksWithParts`, which is a different shape, so
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
    return {};
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
      return byBook;
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

/**
 * Everything the reader needs for one page, or null when the book, the
 * issue or the page does not exist (or the book is a draft and
 * `publishedOnly` is set). `basePath` roots the prev and next links, so the
 * admin preview keeps its readers on `/admin/preview`.
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
  const issue = manifest.books
    .find((b) => b.id === bookId)
    ?.issues.find((i) => i.id === issueId);
  if (!issue) return null;

  const pageCount = pageCountFor(
    bookId,
    issueId,
    issue.pageCount,
    await getStoredPageCounts(bookId),
  );

  const pageNum = parseInt(pageNumber, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > pageCount) return null;

  const [{ bubbles, timestamps }, panels] = await Promise.all([
    getPageData(bookId, issueId, pageNumber),
    getPanelsForPage(bookId, issueId, pageNum),
  ]);

  const pageLink = (n: number) => `${basePath}/${bookId}/${issueId}/${n}`;

  return {
    pageImage: pageImageUrl(bookId, issueId, pageNum),
    bubbles,
    timestamps,
    bookId,
    issueId,
    pageNumber: pageNum,
    pageCount,
    prevPageLink: pageNum > 1 ? pageLink(pageNum - 1) : null,
    nextPageLink: pageNum < pageCount ? pageLink(pageNum + 1) : null,
    panels,
  };
}
