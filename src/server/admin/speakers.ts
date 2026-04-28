import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

export interface SpeakerReview {
  /** speaker_reviews.id (UUID) — null if no row exists yet (synthetic, lazy-created on action) */
  id: string | null;
  originalName: string;
  resolvedName: string | null;
  status: "pending" | "accepted" | "renamed" | "skipped";
  autoAccepted: boolean;
  saveAsAlias: boolean;
  aliasScope: "global" | "book" | null;
  sampleText: string | null;
  pageNumbers: number[];
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
}

interface BubbleRow {
  speaker: string | null;
  page_number: number;
  ocr_text: string | null;
  text_with_cues: string | null;
  type: string;
}

/**
 * Derive speaker reviews live from the bubbles table, joined against any
 * persisted speaker_reviews rows (for decisions already taken) and the
 * characters/aliases registry (for auto-known names).
 *
 * The browser doesn't depend on a separate script run to populate the queue.
 */
export async function getSpeakerReviews(
  bookId: string,
  issueId: string,
): Promise<SpeakerReview[]> {
  // 1. Pull all SPEECH bubbles with a non-null speaker
  const { data: bubbleRows, error: bErr } = await supabaseAdmin
    .from("bubbles")
    .select("speaker, page_number, ocr_text, text_with_cues, type")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .eq("type", "SPEECH")
    .not("speaker", "is", null)
    .order("page_number")
    .order("sort_order");
  if (bErr) {
    console.error("getSpeakerReviews bubbles:", bErr);
    return [];
  }

  // 2. Aggregate by canonical speaker name
  type Aggregate = {
    pageNumbers: Set<number>;
    bubbleCount: number;
    sampleText: string | null;
  };
  const bySpeaker = new Map<string, Aggregate>();
  for (const row of (bubbleRows ?? []) as BubbleRow[]) {
    const name = row.speaker;
    if (!name) continue;
    const agg = bySpeaker.get(name) ?? {
      pageNumbers: new Set<number>(),
      bubbleCount: 0,
      sampleText: null,
    };
    agg.pageNumbers.add(row.page_number);
    agg.bubbleCount += 1;
    if (!agg.sampleText) {
      const text = row.text_with_cues ?? row.ocr_text ?? "";
      if (text.trim()) agg.sampleText = text.slice(0, 160);
    }
    bySpeaker.set(name, agg);
  }

  if (bySpeaker.size === 0) return [];

  // 3. Pull existing speaker_reviews rows for this issue
  const { data: reviewRows } = await supabaseAdmin
    .from("speaker_reviews")
    .select(
      "id, original_name, resolved_name, status, auto_accepted, save_as_alias, alias_scope",
    )
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  const reviewByName = new Map<string, SpeakerReviewRow>();
  for (const r of (reviewRows ?? []) as SpeakerReviewRow[]) {
    reviewByName.set(r.original_name, r);
  }

  // 4. Pull aliases (global + book-scoped) and characters with ready voices,
  //    used to auto-mark known speakers
  const [{ data: aliasRows }, { data: charRows }, { data: castRows }] =
    await Promise.all([
      supabaseAdmin
        .from("aliases")
        .select("alias, canonical, scope, scope_id")
        .or(`scope.eq.global,and(scope.eq.book,scope_id.eq.${bookId})`),
      supabaseAdmin
        .from("character_appearances")
        .select("character_id, voice_status, voice_model_status"),
      supabaseAdmin
        .from("castlist")
        .select("character, voice_id")
        .eq("book_id", bookId)
        .eq("issue_id", issueId),
    ]);

  const aliasMap = new Map<string, string>();
  for (const r of (aliasRows ?? []) as Array<{
    alias: string;
    canonical: string;
  }>) {
    aliasMap.set(r.alias.toLowerCase().trim(), r.canonical);
  }
  const readyCharacters = new Set<string>();
  for (const r of (charRows ?? []) as Array<{
    character_id: string;
    voice_status: string | null;
    voice_model_status: string | null;
  }>) {
    if (r.voice_status === "ready" || r.voice_model_status === "ready") {
      readyCharacters.add(r.character_id);
    }
  }
  const castedCharacters = new Set<string>();
  for (const r of (castRows ?? []) as Array<{
    character: string;
    voice_id: string;
  }>) {
    castedCharacters.add(r.character);
  }

  // 5. Merge into SpeakerReview list
  const result: SpeakerReview[] = [];
  for (const [name, agg] of bySpeaker) {
    const persisted = reviewByName.get(name);
    const aliased = aliasMap.get(name.toLowerCase().trim());
    const canonicalGuess = aliased ?? name;
    const autoKnown =
      readyCharacters.has(canonicalGuess) ||
      castedCharacters.has(canonicalGuess);

    if (persisted) {
      result.push({
        id: persisted.id,
        originalName: name,
        resolvedName: persisted.resolved_name,
        status: persisted.status as SpeakerReview["status"],
        autoAccepted: persisted.auto_accepted,
        saveAsAlias: persisted.save_as_alias,
        aliasScope:
          persisted.alias_scope === "global" || persisted.alias_scope === "book"
            ? persisted.alias_scope
            : null,
        sampleText: agg.sampleText,
        pageNumbers: Array.from(agg.pageNumbers).sort((a, b) => a - b),
        bubbleCount: agg.bubbleCount,
      });
    } else if (autoKnown) {
      // Auto-resolved via alias-map / registry — don't even need to ask
      result.push({
        id: null,
        originalName: name,
        resolvedName: canonicalGuess,
        status: "accepted",
        autoAccepted: true,
        saveAsAlias: false,
        aliasScope: null,
        sampleText: agg.sampleText,
        pageNumbers: Array.from(agg.pageNumbers).sort((a, b) => a - b),
        bubbleCount: agg.bubbleCount,
      });
    } else {
      result.push({
        id: null,
        originalName: name,
        resolvedName: null,
        status: "pending",
        autoAccepted: false,
        saveAsAlias: false,
        aliasScope: null,
        sampleText: agg.sampleText,
        pageNumbers: Array.from(agg.pageNumbers).sort((a, b) => a - b),
        bubbleCount: agg.bubbleCount,
      });
    }
  }

  // Sort: pending first, then resolved (non-auto), then auto-accepted
  result.sort((a, b) => {
    const rank = (r: SpeakerReview) =>
      r.autoAccepted ? 2 : r.status === "pending" ? 0 : 1;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.originalName.localeCompare(b.originalName);
  });

  return result;
}

export async function getKnownCharactersForIssue(
  bookId: string,
): Promise<string[]> {
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
