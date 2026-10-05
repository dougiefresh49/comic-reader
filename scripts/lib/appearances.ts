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
const MEDIA = new Set([
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
  const sb = client as SupabaseClient<Database>;
  const w = await sb
    .from("works")
    .upsert([...works.values()], { onConflict: "id", ignoreDuplicates: true });
  if (w.error) throw new Error(`works upsert: ${w.error.message}`);
  const a = await sb.from("appearances").upsert([...appearances.values()], {
    onConflict: "character_id,work_id",
    ignoreDuplicates: true,
  });
  if (a.error) throw new Error(`appearances upsert: ${a.error.message}`);
  return { listed: appearances.size, skipped };
}
