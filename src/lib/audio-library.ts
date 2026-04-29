/**
 * Public URL helpers for the global audio library.
 *
 * Files live at `comic-audio/library/<layer>/<tag>.mp3` in the public
 * Supabase bucket. The bucket is public so playback uses plain <audio>
 * with the URL — no signed URLs, no auth roundtrip.
 *
 * Tag → URL is the only resolution we do. Cache misses (a tag not yet
 * sourced) just play silence — the runtime layer tolerates 404s.
 */

export type AudioLayer = "ambience" | "sfx" | "music";

function storageBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function audioLibraryUrl(layer: AudioLayer, tag: string): string {
  return `${storageBase()}/storage/v1/object/public/comic-audio/library/${layer}/${encodeURIComponent(tag)}.mp3`;
}
