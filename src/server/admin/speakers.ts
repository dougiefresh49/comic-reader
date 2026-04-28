import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

export interface SpeakerReview {
  id: string;
  originalName: string;
  resolvedName: string | null;
  status: "pending" | "accepted" | "renamed" | "skipped";
  autoAccepted: boolean;
  saveAsAlias: boolean;
  aliasScope: "global" | "book" | null;
  sampleText: string | null;
  pageNumbers: number[] | null;
  bubbleCount: number;
}

interface SpeakerReviewRow {
  id: string;
  original_name: string;
  resolved_name: string | null;
  status: string;
  auto_accepted: boolean;
  save_as_alias: boolean;
  alias_scope: string | null;
  sample_text: string | null;
  page_numbers: number[] | null;
  bubble_count: number;
}

function rowToReview(row: SpeakerReviewRow): SpeakerReview {
  return {
    id: row.id,
    originalName: row.original_name,
    resolvedName: row.resolved_name,
    status: row.status as SpeakerReview["status"],
    autoAccepted: row.auto_accepted,
    saveAsAlias: row.save_as_alias,
    aliasScope:
      row.alias_scope === "global" || row.alias_scope === "book"
        ? row.alias_scope
        : null,
    sampleText: row.sample_text,
    pageNumbers: row.page_numbers,
    bubbleCount: row.bubble_count,
  };
}

export async function getSpeakerReviews(
  bookId: string,
  issueId: string,
): Promise<SpeakerReview[]> {
  const { data, error } = await supabaseAdmin
    .from("speaker_reviews")
    .select(
      "id, original_name, resolved_name, status, auto_accepted, save_as_alias, alias_scope, sample_text, page_numbers, bubble_count",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("auto_accepted", { ascending: true })
    .order("status")
    .order("original_name");
  if (error) {
    console.error("getSpeakerReviews:", error);
    return [];
  }
  return ((data ?? []) as SpeakerReviewRow[]).map(rowToReview);
}

export async function getKnownCharactersForIssue(
  bookId: string,
): Promise<string[]> {
  // Pull canonical character names from castlist (already resolved + voiced)
  // plus characters table for franchise-wide options
  const { data: castRows } = await supabaseAdmin
    .from("castlist")
    .select("character")
    .eq("book_id", bookId);
  const { data: charRows } = await supabaseAdmin
    .from("characters")
    .select("id, aliases");
  const set = new Set<string>();
  for (const r of (castRows ?? []) as Array<{ character: string }>) {
    set.add(r.character);
  }
  for (const r of (charRows ?? []) as Array<{
    id: string;
    aliases: string[] | null;
  }>) {
    set.add(r.id);
    for (const a of r.aliases ?? []) set.add(a);
  }
  return Array.from(set).sort();
}
