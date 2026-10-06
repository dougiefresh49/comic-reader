/**
 * Writes the local character registry's appearances as `works` and
 * `appearances` rows (#458), the way the casting backfill built them from
 * the old table: the work id is `slugify(title) + "-" + year`, and a title
 * that carries its own "(year)" loses it. Both inserts do nothing on
 * conflict, so a rerun never overwrites what the database already holds.
 * Voice state is not an appearance fact: the `voices` table is its home.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "~/lib/character-id";
import type { Database } from "~/types/database";

/** The `works.medium` check constraint. */
export const MEDIA: ReadonlySet<string> = new Set([
  "movie",
  "animated_series",
  "live_action",
  "video_game",
  "comic",
  "podcast",
]);

/** One registry appearance, as find-voice-sources and migrate-to-db hold it. */
export interface RegistryAppearance {
  id: string;
  mediaTitle?: string | null;
  year?: number | null;
  voiceActor?: string | null;
  mediaType?: string | null;
  youtubeSearchTerms?: string[];
  notes?: string | null;
}

type Work = Database["public"]["Tables"]["works"]["Insert"];
type Appearance = Database["public"]["Tables"]["appearances"]["Insert"];

/**
 * Upserts the works and appearances of `characterId`'s registry entries.
 * A `voice_design` entry is no appearance and is left out silently; one with
 * no title, no year, or a medium the check refuses is left out and named
 * in `skipped`. `listed` counts the appearances sent, new or already
 * there. The `characters` row must exist first.
 */
export async function writeAppearances(
  client: SupabaseClient,
  characterId: string,
  entries: RegistryAppearance[],
): Promise<{ listed: number; skipped: string[] }> {
  const works = new Map<string, Work>();
  const appearances = new Map<string, Appearance>();
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.mediaType === "voice_design") continue;
    const medium = e.mediaType ?? "";
    if (!e.mediaTitle?.trim() || !e.year || !MEDIA.has(medium)) {
      skipped.push(
        `${e.id} (${!e.mediaTitle?.trim() ? "no title" : !e.year ? "no year" : `medium "${medium}" is not a works.medium`})`,
      );
      continue;
    }
    const title = e.mediaTitle
      .replace(new RegExp(`\\s*\\(${e.year}\\)\\s*$`), "")
      .trim();
    const workId = `${slugify(title)}-${e.year}`;
    if (!works.has(workId))
      works.set(workId, { id: workId, title, year: e.year, medium });
    if (!appearances.has(workId))
      appearances.set(workId, {
        character_id: characterId,
        work_id: workId,
        voice_actor: e.voiceActor ?? null,
        search_terms: e.youtubeSearchTerms ?? [],
        notes: e.notes ?? null,
      });
  }
  if (works.size === 0) return { listed: 0, skipped };
  await insertWorks(client, [...works.values()]);
  await insertAppearances(client, [...appearances.values()]);
  return { listed: appearances.size, skipped };
}

/** Inserts works by id; a row already there is left as it is. */
export async function insertWorks(
  client: SupabaseClient,
  rows: Work[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await (client as SupabaseClient<Database>)
    .from("works")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`works upsert: ${error.message}`);
}

/** Inserts appearances on (character_id, work_id); one already there is left. */
export async function insertAppearances(
  client: SupabaseClient,
  rows: Appearance[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await (client as SupabaseClient<Database>)
    .from("appearances")
    .upsert(rows, {
      onConflict: "character_id,work_id",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(`appearances upsert: ${error.message}`);
}

const PAGE = 1000;

/** Every `works` row, ordered by id. */
export async function readWorks(
  client: SupabaseClient,
): Promise<Database["public"]["Tables"]["works"]["Row"][]> {
  const rows: Database["public"]["Tables"]["works"]["Row"][] = [];
  for (;;) {
    const { data, error } = await (client as SupabaseClient<Database>)
      .from("works")
      .select("*")
      .order("id")
      .range(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`read works: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
  }
}

/** Every `appearances` row, ordered by id. */
export async function readAppearances(
  client: SupabaseClient,
): Promise<Database["public"]["Tables"]["appearances"]["Row"][]> {
  const rows: Database["public"]["Tables"]["appearances"]["Row"][] = [];
  for (;;) {
    const { data, error } = await (client as SupabaseClient<Database>)
      .from("appearances")
      .select("*")
      .order("id")
      .range(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`read appearances: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
  }
}
