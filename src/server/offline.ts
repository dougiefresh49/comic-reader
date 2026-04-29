import "server-only";
import { supabase } from "~/lib/supabase";
import { audioLibraryUrl } from "~/lib/audio-library";
import { audioUrl, pageImageUrl } from "~/lib/storage";
import { parseTag } from "~/lib/audio-library";

/**
 * Build the full set of URLs the reader needs to play an issue
 * offline: all page WebPs, all bubble dialogue audio, plus every
 * library audio file referenced by any panel's tags.
 *
 * The result is sent to the service worker via postMessage so it can
 * pre-fill the cache before the kid goes off-network.
 */
export async function getIssueOfflineUrls(
  bookId: string,
  issueId: string,
  pageCount: number,
): Promise<string[]> {
  const urls = new Set<string>();

  // 1. Page images.
  for (let p = 1; p <= pageCount; p++) {
    urls.add(pageImageUrl(bookId, issueId, p));
  }

  // 2. Bubble dialogue audio (one mp3 per bubble that has audio).
  const { data: bubbles } = await supabase
    .from("bubbles")
    .select("id, audio_storage_path")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("audio_storage_path", "is", null);
  for (const b of (bubbles ?? []) as Array<{
    id: string;
    audio_storage_path: string | null;
  }>) {
    if (b.audio_storage_path) {
      urls.add(audioUrl(bookId, issueId, b.audio_storage_path));
    }
  }

  // 3. Library audio referenced by any panel's audio_tags + effect_tags
  //    that map to a sfx file. Effect tags don't have audio of their own,
  //    so only ambience/sfx/music_mood are relevant.
  const { data: panels } = await supabase
    .from("panels")
    .select("audio_tags")
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  for (const p of (panels ?? []) as Array<{
    audio_tags: {
      ambience?: string[];
      sfx?: string[];
      music_mood?: string;
    } | null;
  }>) {
    const tags = p.audio_tags;
    if (!tags) continue;
    for (const t of tags.ambience ?? []) {
      const { base, variant } = parseTag(t);
      urls.add(
        audioLibraryUrl("ambience", variant ? `${base}@${variant}` : base),
      );
    }
    for (const t of tags.sfx ?? []) {
      const { base, variant } = parseTag(t);
      urls.add(audioLibraryUrl("sfx", variant ? `${base}@${variant}` : base));
    }
    if (tags.music_mood) {
      const { base, variant } = parseTag(tags.music_mood);
      urls.add(audioLibraryUrl("music", variant ? `${base}@${variant}` : base));
    }
  }

  return Array.from(urls);
}
