import "server-only";
import { supabase } from "~/lib/supabase";
import type { Bubble, AudioTimestamps } from "~/types";
import type { BookManifest, Manifest } from "~/types/manifest";

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
}

interface TimestampRow {
  bubble_id: string;
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
        "id, ocr_text, text_with_cues, type, speaker, emotion, ai_reasoning, ignored, box_2d, style, audio_storage_path, page_number, sort_order",
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
    const bubbleIds = rows.map((r) => r.id);

    let tsRows: TimestampRow[] = [];
    if (bubbleIds.length > 0) {
      const { data: tsData, error: tsError } = await supabase
        .from("audio_timestamps")
        .select("bubble_id, alignment, normalized_alignment")
        .eq("book_id", bookId)
        .eq("issue_id", issueId)
        .in("bubble_id", bubbleIds);

      if (tsError) {
        console.error("getPageData timestamps:", tsError);
      } else {
        tsRows = (tsData ?? []) as TimestampRow[];
      }
    }

    const timestamps: Record<string, AudioTimestamps> = {};
    for (const ts of tsRows) {
      timestamps[ts.bubble_id] = {
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
    if (!allBubbles[key]) allBubbles[key] = [];
    allBubbles[key].push(rowToBubble(row));
  }

  const { data: castRows, error: castError } = await supabase
    .from("castlist")
    .select("character")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);

  let characters: string[] = [];
  if (!castError && castRows?.length) {
    characters = castRows.map((r) => r.character).sort();
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

export async function getManifest(): Promise<Manifest> {
  const { data, error } = await supabase
    .from("books")
    .select(
      "id, name, issues(id, number, name, page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps)",
    )
    .order("number", { ascending: true, foreignTable: "issues" });

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
