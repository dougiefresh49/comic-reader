import "server-only";
import { supabaseAdmin } from "~/lib/supabase-admin";
import type { AudioLayer } from "~/lib/audio-library";

/**
 * Per-tag variant listing for the audio library.
 *
 * Walks `comic-audio/library/<layer>/` for each layer and groups files
 * by base tag. Filename rules:
 *   - `<tag>.mp3`              → the default (variant=null)
 *   - `<tag>.<variant>.mp3`    → a named variant
 */

export interface TagVariants {
  /** Slug like "bowstaff", or null for the bare default file. */
  variant: string | null;
  /** "<tag>.mp3" or "<tag>.<variant>.mp3" — the full filename in the bucket. */
  filename: string;
  size: number;
  updatedAt: string | null;
}

export type AudioLibraryListing = Record<
  AudioLayer,
  Record<string, TagVariants[]>
>;

const LAYERS: AudioLayer[] = ["ambience", "sfx", "music"];

interface BucketEntry {
  name: string;
  metadata?: { size?: number } | null;
  updated_at?: string | null;
}

function parseFilename(file: string): {
  base: string;
  variant: string | null;
} | null {
  if (!file.endsWith(".mp3")) return null;
  const stem = file.slice(0, -".mp3".length);
  const dot = stem.indexOf(".");
  if (dot < 0) return { base: stem, variant: null };
  return { base: stem.slice(0, dot), variant: stem.slice(dot + 1) };
}

export async function getAudioLibraryListing(): Promise<AudioLibraryListing> {
  const result: AudioLibraryListing = { ambience: {}, sfx: {}, music: {} };

  await Promise.all(
    LAYERS.map(async (layer) => {
      const { data, error } = await supabaseAdmin.storage
        .from("comic-audio")
        .list(`library/${layer}`, {
          limit: 1000,
          sortBy: { column: "name", order: "asc" },
        });
      if (error || !data) return;
      for (const entry of data as BucketEntry[]) {
        const parsed = parseFilename(entry.name);
        if (!parsed) continue;
        const list = (result[layer][parsed.base] ??= []);
        list.push({
          variant: parsed.variant,
          filename: entry.name,
          size: entry.metadata?.size ?? 0,
          updatedAt: entry.updated_at ?? null,
        });
      }
      // sort: default first, then variants alphabetically
      for (const base of Object.keys(result[layer])) {
        result[layer][base]!.sort((a, b) => {
          if (a.variant === null) return -1;
          if (b.variant === null) return 1;
          return a.variant.localeCompare(b.variant);
        });
      }
    }),
  );

  return result;
}

/** Flat map of `${layer}:${base}` → variant slugs (excludes the default). */
export function variantsByTag(
  listing: AudioLibraryListing,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const layer of LAYERS) {
    for (const [base, files] of Object.entries(listing[layer])) {
      const variants = files
        .map((f) => f.variant)
        .filter((v): v is string => v !== null);
      if (variants.length > 0) out[`${layer}:${base}`] = variants;
    }
  }
  return out;
}
