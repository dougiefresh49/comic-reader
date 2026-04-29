/**
 * Public URL helpers for the global audio library.
 *
 * Files live at `comic-audio/library/<layer>/<tag>.mp3` in the public
 * Supabase bucket. The bucket is public so playback uses plain <audio>
 * with the URL — no signed URLs, no auth roundtrip.
 *
 * # Variants
 *
 * A tag can have alternate clips under the same logical category. The
 * default for `sword_clang` is `library/sfx/sword_clang.mp3`. A
 * "bowstaff" variant lives at `library/sfx/sword_clang.bowstaff.mp3`.
 *
 * Tag strings carried by panels gain an optional `@variant` suffix:
 *   - `sword_clang`           → default file
 *   - `sword_clang@bowstaff`  → bowstaff variant
 *
 * The `@` syntax is opt-in: every existing string keeps working
 * untouched. Resolution always falls back to the default if a variant
 * is requested but missing.
 */

export type AudioLayer = "ambience" | "sfx" | "music";

export interface ParsedTag {
  base: string;
  variant: string | null;
}

function storageBase(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Split a `tag` or `tag@variant` string into its parts. */
export function parseTag(s: string): ParsedTag {
  const at = s.indexOf("@");
  if (at < 0) return { base: s, variant: null };
  return { base: s.slice(0, at), variant: s.slice(at + 1) || null };
}

export function formatTag(base: string, variant: string | null): string {
  return variant ? `${base}@${variant}` : base;
}

/**
 * Build the bucket path for a tag (with or without an `@variant` suffix).
 * Default: `library/<layer>/<tag>.mp3`
 * Variant: `library/<layer>/<tag>.<variant>.mp3`
 */
export function audioLibraryStoragePath(
  layer: AudioLayer,
  tagWithVariant: string,
): string {
  const { base, variant } = parseTag(tagWithVariant);
  const file = variant ? `${base}.${variant}` : base;
  return `library/${layer}/${file}.mp3`;
}

export function audioLibraryUrl(
  layer: AudioLayer,
  tagWithVariant: string,
): string {
  return `${storageBase()}/storage/v1/object/public/comic-audio/${audioLibraryStoragePath(layer, tagWithVariant)}`;
}

/** A safe slug for a user-supplied variant name. */
export function slugifyVariant(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
