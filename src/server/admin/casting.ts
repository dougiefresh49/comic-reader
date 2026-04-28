import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";

export interface CastingAppearance {
  id: string;
  mediaTitle: string | null;
  year: number | null;
  voiceActor: string | null;
  mediaType: string | null;
  youtubeSearchTerms: string[] | null;
  notes: string | null;
  voiceId: string | null;
  voiceType: string | null;
  voiceStatus: string | null;
  voiceDescription: string | null;
  clipStoragePath: string | null;
  clipSourceUrl: string | null;
  clipDurationSecs: number | null;
  voiceModelStatus: string;
  voiceModelError: string | null;
  voiceModelStartedAt: string | null;
}

export interface CastingTask {
  id: string;
  bookId: string;
  issueId: string;
  characterId: string;
  characterName: string;
  franchise: string | null;
  status: "pending" | "in_progress" | "complete" | "skipped";
  appearances: CastingAppearance[];
}

interface TaskRow {
  id: string;
  book_id: string;
  issue_id: string;
  character_id: string;
  status: string;
  characters: { id: string; franchise: string | null } | null;
}

interface AppearanceRow {
  id: string;
  character_id: string;
  media_title: string | null;
  year: number | null;
  voice_actor: string | null;
  media_type: string | null;
  youtube_search_terms: string[] | null;
  notes: string | null;
  voice_id: string | null;
  voice_type: string | null;
  voice_status: string | null;
  voice_description: string | null;
  clip_storage_path: string | null;
  clip_source_url: string | null;
  clip_duration_secs: number | null;
  voice_model_status: string;
  voice_model_error: string | null;
  voice_model_started_at: string | null;
}

function rowToAppearance(r: AppearanceRow): CastingAppearance {
  return {
    id: r.id,
    mediaTitle: r.media_title,
    year: r.year,
    voiceActor: r.voice_actor,
    mediaType: r.media_type,
    youtubeSearchTerms: r.youtube_search_terms,
    notes: r.notes,
    voiceId: r.voice_id,
    voiceType: r.voice_type,
    voiceStatus: r.voice_status,
    voiceDescription: r.voice_description,
    clipStoragePath: r.clip_storage_path,
    clipSourceUrl: r.clip_source_url,
    clipDurationSecs: r.clip_duration_secs,
    voiceModelStatus: r.voice_model_status,
    voiceModelError: r.voice_model_error,
    voiceModelStartedAt: r.voice_model_started_at,
  };
}

export async function getCastingTasks(
  bookId?: string,
  issueId?: string,
): Promise<CastingTask[]> {
  let q = supabaseAdmin
    .from("casting_tasks")
    .select(
      "id, book_id, issue_id, character_id, status, characters(id, franchise)",
    )
    .neq("status", "complete")
    .order("created_at");
  if (bookId) q = q.eq("book_id", bookId);
  if (issueId) q = q.eq("issue_id", issueId);

  const { data, error } = await q;
  if (error) {
    console.error("getCastingTasks:", error);
    return [];
  }
  const tasks = (data ?? []) as unknown as TaskRow[];
  if (tasks.length === 0) return [];

  const charIds = Array.from(new Set(tasks.map((t) => t.character_id)));
  const { data: appData } = await supabaseAdmin
    .from("character_appearances")
    .select(
      "id, character_id, media_title, year, voice_actor, media_type, youtube_search_terms, notes, voice_id, voice_type, voice_status, voice_description, clip_storage_path, clip_source_url, clip_duration_secs, voice_model_status, voice_model_error, voice_model_started_at",
    )
    .in("character_id", charIds);
  const apps = (appData ?? []) as AppearanceRow[];
  const byChar = new Map<string, CastingAppearance[]>();
  for (const a of apps) {
    const list = byChar.get(a.character_id) ?? [];
    list.push(rowToAppearance(a));
    byChar.set(a.character_id, list);
  }

  return tasks.map((t) => ({
    id: t.id,
    bookId: t.book_id,
    issueId: t.issue_id,
    characterId: t.character_id,
    characterName: t.characters?.id ?? t.character_id,
    franchise: t.characters?.franchise ?? null,
    status: t.status as CastingTask["status"],
    appearances: byChar.get(t.character_id) ?? [],
  }));
}
