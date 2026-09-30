import type { SupabaseClient } from "@supabase/supabase-js";
import { md5Hex } from "./elevenlabs";

/** The private bucket that is the only restore source (decisions row 24). */
export const VOICE_CLIPS_BUCKET = "comic-voice-clips";

const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/**
 * `source_clip_path` is an object path inside the bucket. Older rows may
 * carry the bucket name as a prefix; the snapshot path `<voices.id>/<file>`
 * has a slash of its own, so a slash is never a bucket separator here.
 */
export function clipObjectPath(sourceClipPath: string): string {
  const prefix = `${VOICE_CLIPS_BUCKET}/`;
  return sourceClipPath.startsWith(prefix)
    ? sourceClipPath.slice(prefix.length)
    : sourceClipPath;
}

export function clipFileName(objectPath: string): string {
  return objectPath.split("/").pop() ?? objectPath;
}

export function clipContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "audio/mpeg";
}

/** Null when the object is missing; throws on any other Storage error. */
export async function downloadClip(
  supabase: SupabaseClient,
  objectPath: string,
): Promise<Uint8Array | null> {
  const { data, error } = await supabase.storage
    .from(VOICE_CLIPS_BUCKET)
    .download(objectPath);
  if (error) {
    if (/not found|does not exist|404/i.test(error.message)) return null;
    throw new Error(
      `download ${VOICE_CLIPS_BUCKET}/${objectPath}: ${error.message}`,
    );
  }
  if (!data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export type ClipCheck =
  | { status: "ok"; bytes: Uint8Array; md5: string }
  | { status: "missing" }
  | { status: "mismatch"; md5: string };

/** Downloads and hashes the object: the exact check, not the eTag. */
export async function checkClip(
  supabase: SupabaseClient,
  objectPath: string,
  expectedMd5: string,
): Promise<ClipCheck> {
  const bytes = await downloadClip(supabase, objectPath);
  if (!bytes) return { status: "missing" };
  const md5 = md5Hex(bytes);
  if (md5 !== expectedMd5) return { status: "mismatch", md5 };
  return { status: "ok", bytes, md5 };
}

/**
 * Uploads without overwrite. An object already there is fine only when its
 * bytes hash the same; anything else is an error, never a silent replace.
 */
export async function uploadClip(
  supabase: SupabaseClient,
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const store = supabase.storage.from(VOICE_CLIPS_BUCKET);
  const up = await store.upload(objectPath, bytes, {
    contentType,
    upsert: false,
  });
  if (up.error && !/exist|duplicate/i.test(up.error.message))
    throw new Error(
      `upload ${VOICE_CLIPS_BUCKET}/${objectPath}: ${up.error.message}`,
    );
  const stored = await checkClip(supabase, objectPath, md5Hex(bytes));
  if (stored.status !== "ok")
    throw new Error(
      `upload ${VOICE_CLIPS_BUCKET}/${objectPath}: stored copy ${stored.status === "missing" ? "missing" : `md5 ${stored.md5} differs`}`,
    );
}
