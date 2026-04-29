"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";
import {
  audioLibraryStoragePath,
  slugifyVariant,
  type AudioLayer,
} from "~/lib/audio-library";

interface ActionResult {
  ok: boolean;
  error?: string;
}

function targetPath(
  layer: AudioLayer,
  base: string,
  variant: string | null,
): string {
  const v = variant ? slugifyVariant(variant) : null;
  return audioLibraryStoragePath(layer, v ? `${base}@${v}` : base);
}

async function uploadAudio(path: string, buf: Buffer): Promise<ActionResult> {
  const { error } = await supabaseAdmin.storage
    .from("comic-audio")
    .upload(path, buf, { contentType: "audio/mpeg", upsert: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Freesound search ─────────────────────────────────────────────────────

export interface FreesoundHit {
  id: number;
  name: string;
  duration: number;
  username: string;
  license: string;
  /** Token-authenticated preview URL (no OAuth needed). */
  previewUrl: string;
}

export async function searchFreesound(
  layer: AudioLayer,
  query: string,
): Promise<{ ok: boolean; results: FreesoundHit[]; error?: string }> {
  const apiKey = process.env.FREESOUND_API_KEY;
  if (!apiKey) {
    return { ok: false, results: [], error: "FREESOUND_API_KEY not set" };
  }
  const durationFilter =
    layer === "sfx"
      ? "duration:[0.2 TO 4]"
      : layer === "ambience"
        ? "duration:[8 TO 30]"
        : "duration:[20 TO 60]";
  const params = new URLSearchParams({
    query,
    filter: `${durationFilter} (license:"Creative Commons 0" OR license:"Attribution")`,
    fields: "id,name,duration,username,license,previews",
    page_size: "10",
    sort: "rating_desc",
    token: apiKey,
  });
  const res = await fetch(
    `https://freesound.org/apiv2/search/text/?${params.toString()}`,
  );
  if (!res.ok) {
    return {
      ok: false,
      results: [],
      error: `freesound ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }
  interface SearchJson {
    results: Array<{
      id: number;
      name: string;
      duration: number;
      username: string;
      license: string;
      previews: { "preview-hq-mp3": string };
    }>;
  }
  const json = (await res.json()) as SearchJson;
  return {
    ok: true,
    results: json.results.map((r) => ({
      id: r.id,
      name: r.name,
      duration: r.duration,
      username: r.username,
      license: r.license,
      previewUrl: r.previews["preview-hq-mp3"],
    })),
  };
}

// ─── Save flows ───────────────────────────────────────────────────────────

interface SaveCommonArgs {
  layer: AudioLayer;
  base: string;
  /** Slug for the variant; null/"" → overwrite the default. */
  variant: string | null;
}

export async function saveFromFreesound(
  args: SaveCommonArgs & { previewUrl: string },
): Promise<ActionResult> {
  const res = await fetch(args.previewUrl);
  if (!res.ok) return { ok: false, error: `download ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const result = await uploadAudio(
    targetPath(args.layer, args.base, args.variant),
    buf,
  );
  if (result.ok) revalidatePath("/admin/audio-library");
  return result;
}

export async function generateAudioWithElevenLabs(
  args: SaveCommonArgs & { prompt: string; durationSeconds?: number },
): Promise<ActionResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY not set" };

  let buf: Buffer;
  if (args.layer === "music") {
    // ElevenLabs Music: ~30s loop by default
    const ms = (args.durationSeconds ?? 30) * 1000;
    for (const path of ["/v1/music/compose", "/v1/music"]) {
      const res = await fetch(`https://api.elevenlabs.io${path}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          prompt: args.prompt,
          music_length_ms: ms,
        }),
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        return {
          ok: false,
          error: `elevenlabs music ${res.status}: ${(await res.text()).slice(0, 200)}`,
        };
      }
      buf = Buffer.from(await res.arrayBuffer());
      break;
    }
    // @ts-expect-error — buf assigned in the loop above when one of the paths returns 200
    if (!buf) return { ok: false, error: "music endpoint not found" };
  } else {
    // ElevenLabs Sound Generation for sfx + ambience
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: args.prompt,
        duration_seconds:
          args.durationSeconds ?? (args.layer === "sfx" ? 1.5 : 12),
        prompt_influence: 0.6,
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `elevenlabs sfx ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    buf = Buffer.from(await res.arrayBuffer());
  }

  const result = await uploadAudio(
    targetPath(args.layer, args.base, args.variant),
    buf,
  );
  if (result.ok) revalidatePath("/admin/audio-library");
  return result;
}

export async function uploadAudioBytes(
  args: SaveCommonArgs & { base64: string },
): Promise<ActionResult> {
  const buf = Buffer.from(args.base64, "base64");
  if (buf.length === 0) return { ok: false, error: "empty file" };
  if (buf.length > 10 * 1024 * 1024)
    return { ok: false, error: "file too large (10 MB max)" };
  const result = await uploadAudio(
    targetPath(args.layer, args.base, args.variant),
    buf,
  );
  if (result.ok) revalidatePath("/admin/audio-library");
  return result;
}

export async function deleteAudioVariant(args: {
  layer: AudioLayer;
  filename: string;
}): Promise<ActionResult> {
  const path = `library/${args.layer}/${args.filename}`;
  const { error } = await supabaseAdmin.storage
    .from("comic-audio")
    .remove([path]);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/audio-library");
  return { ok: true };
}
