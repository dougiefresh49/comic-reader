import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { md5Hex } from "./elevenlabs";
import type { SnapshotManifest, VoiceRow } from "./types";

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
 * `upsert` replaces: only the snapshot manifest, which the module writes
 * itself from hash-checked samples and may widen on a re-snapshot.
 */
export async function uploadClip(
  supabase: SupabaseClient,
  objectPath: string,
  bytes: Uint8Array,
  contentType: string,
  opts: { upsert?: boolean } = {},
): Promise<void> {
  const store = supabase.storage.from(VOICE_CLIPS_BUCKET);
  const up = await store.upload(objectPath, bytes, {
    contentType,
    upsert: opts.upsert ?? false,
  });
  if (up.error && (opts.upsert || !/exist|duplicate/i.test(up.error.message)))
    throw new Error(
      `upload ${VOICE_CLIPS_BUCKET}/${objectPath}: ${up.error.message}`,
    );
  if (opts.upsert) return;
  const stored = await checkClip(supabase, objectPath, md5Hex(bytes));
  if (stored.status !== "ok")
    throw new Error(
      `upload ${VOICE_CLIPS_BUCKET}/${objectPath}: stored copy ${stored.status === "missing" ? "missing" : `md5 ${stored.md5} differs`}`,
    );
}

const MANIFEST_FILE = "snapshot.json";

/** Where a voice's snapshot manifest sits, beside its clips. */
export function manifestObjectPath(voiceId: string): string {
  return `${voiceId}/${MANIFEST_FILE}`;
}

const manifestSchema = z.object({
  voiceId: z.string(),
  formerElevenLabsId: z.string(),
  samples: z
    .array(
      z.object({
        fileName: z.string().min(1),
        objectPath: z.string().min(1),
        md5: z.string().regex(/^[a-f0-9]{32}$/),
        elevenLabsHash: z.string().regex(/^[a-f0-9]{32}$/),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

/** Null for legacy snapshots and imported single clips without a manifest. */
export async function readManifest(
  supabase: SupabaseClient,
  voiceId: string,
): Promise<SnapshotManifest | null> {
  const objectPath = manifestObjectPath(voiceId);
  const bytes = await downloadClip(supabase, objectPath);
  if (!bytes) return null;
  try {
    return manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (err) {
    throw new Error(
      `${VOICE_CLIPS_BUCKET}/${objectPath} is not a valid snapshot manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Archive and restore must check the same complete set before any EL write. */
export async function checkSnapshot(supabase: SupabaseClient, voice: VoiceRow) {
  const objectPath = clipObjectPath(voice.source_clip_path!);
  const manifest = await readManifest(supabase, voice.id);
  const samples = manifest?.samples ?? [
    {
      fileName: clipFileName(objectPath),
      objectPath,
      md5: voice.source_clip_md5!,
    },
  ];
  if (
    manifest &&
    (manifest.voiceId !== voice.id ||
      samples[0]!.objectPath !== objectPath ||
      samples[0]!.md5 !== voice.source_clip_md5 ||
      manifest.samples.some(
        (s) =>
          s.objectPath !== `${voice.id}/${s.fileName}` ||
          s.fileName.includes("/") ||
          s.md5 !== s.elevenLabsHash,
      ) ||
      new Set(samples.map((s) => s.objectPath)).size !== samples.length)
  )
    throw new Error(`Snapshot manifest does not match voice ${voice.id}`);
  const files = [];
  for (const sample of samples) {
    const clip = await checkClip(supabase, sample.objectPath, sample.md5);
    if (clip.status !== "ok") return { status: clip.status, files: [] };
    files.push({
      filename: sample.fileName,
      mimeType: clipContentType(sample.fileName),
      bytes: clip.bytes,
    });
  }
  return { status: "ok" as const, files };
}

export async function writeManifest(
  supabase: SupabaseClient,
  manifest: SnapshotManifest,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await uploadClip(
    supabase,
    manifestObjectPath(manifest.voiceId),
    bytes,
    "application/json",
    { upsert: true },
  );
}
