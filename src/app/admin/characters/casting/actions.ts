"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

const SKIPPED_VOICE = "__SKIPPED__";

type ActionResult = { ok: true } | { ok: false; error: string };

interface SaveVoiceIdArgs {
  taskId: string;
  characterId: string;
  bookId: string;
  issueId: string;
  voiceId: string;
  /** Optional: which appearance the user chose as the source — used for record-keeping */
  appearanceId?: string;
}

/**
 * User downloaded a clip locally, created an IVC voice in the ElevenLabs
 * dashboard, and pasted the resulting voice ID. Save it.
 */
export async function saveVoiceId(
  args: SaveVoiceIdArgs,
): Promise<ActionResult> {
  if (!args.voiceId.trim()) {
    return { ok: false, error: "Voice ID required" };
  }
  const trimmed = args.voiceId.trim();

  // 1. Mark the chosen appearance (if any) as ready
  if (args.appearanceId) {
    await supabaseAdmin
      .from("character_appearances")
      .update({
        voice_id: trimmed,
        voice_status: "ready",
        voice_model_status: "ready",
      })
      .eq("id", args.appearanceId);
  }

  // 2. Add to castlist for this issue
  const { data: existing } = await supabaseAdmin
    .from("castlist")
    .select("character")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("character", args.characterId)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from("castlist")
      .update({ voice_id: trimmed })
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId)
      .eq("character", args.characterId);
  } else {
    await supabaseAdmin.from("castlist").insert({
      book_id: args.bookId,
      issue_id: args.issueId,
      character: args.characterId,
      voice_id: trimmed,
    });
  }

  // 3. Mark the casting task complete
  await supabaseAdmin
    .from("casting_tasks")
    .update({
      status: "complete",
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.taskId);

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true };
}

interface SkipArgs {
  taskId: string;
  characterId: string;
  bookId: string;
  issueId: string;
}

/**
 * "Skip and add later" — write a sentinel into castlist so the audio
 * generator skips bubbles spoken by this character. The casting task
 * is marked skipped so the dashboard hides it but it can be revisited.
 */
export async function skipAndAddLater(args: SkipArgs): Promise<ActionResult> {
  const { data: existing } = await supabaseAdmin
    .from("castlist")
    .select("character")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("character", args.characterId)
    .maybeSingle();
  if (!existing) {
    await supabaseAdmin.from("castlist").insert({
      book_id: args.bookId,
      issue_id: args.issueId,
      character: args.characterId,
      voice_id: SKIPPED_VOICE,
    });
  } else {
    await supabaseAdmin
      .from("castlist")
      .update({ voice_id: SKIPPED_VOICE })
      .eq("book_id", args.bookId)
      .eq("issue_id", args.issueId)
      .eq("character", args.characterId);
  }

  await supabaseAdmin
    .from("casting_tasks")
    .update({
      status: "skipped",
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.taskId);

  revalidatePath("/admin/characters/casting", "page");
  return { ok: true };
}

interface MarkSourceArgs {
  appearanceId: string;
}

/**
 * Lightweight bookkeeping: the user said "I'll use this source." We just
 * mark which appearance was chosen so it's clear later which clip the IVC
 * came from. Doesn't trigger any download — the user handles that locally.
 */
export async function markChosenSource(args: MarkSourceArgs) {
  const { error } = await supabaseAdmin
    .from("character_appearances")
    .update({
      voice_model_status: "processing",
      voice_model_started_at: new Date().toISOString(),
    })
    .eq("id", args.appearanceId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/characters/casting", "page");
  return { ok: true };
}

interface CompleteCastingArgs {
  bookId: string;
  issueId: string;
}

/**
 * All casting tasks are done (complete or skipped). Clear the pipeline
 * pause so `pnpm ingest` can resume from where it left off.
 */
export async function completeCasting(
  args: CompleteCastingArgs,
): Promise<ActionResult> {
  const { data: remaining } = await supabaseAdmin
    .from("casting_tasks")
    .select("id")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("status", "pending");

  if (remaining && remaining.length > 0) {
    return {
      ok: false,
      error: `${remaining.length} task(s) still pending`,
    };
  }

  await supabaseAdmin
    .from("issues")
    .update({
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    })
    .eq("book_id", args.bookId)
    .eq("id", args.issueId)
    .eq("pipeline_paused_at", "find-voice-sources");

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true };
}

interface CreateVoiceDesignArgs {
  taskId: string;
  characterId: string;
  bookId: string;
  issueId: string;
  voiceDescription: string;
}

/**
 * Create an ElevenLabs Voice Design voice from a text description.
 * Used for minor/one-off characters where PVC isn't worth sourcing clips.
 */
export async function createVoiceDesign(
  args: CreateVoiceDesignArgs,
): Promise<ActionResult & { voiceId?: string }> {
  if (!args.voiceDescription.trim()) {
    return { ok: false, error: "Voice description required" };
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    return { ok: false, error: "ELEVENLABS_API_KEY not configured" };
  }

  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/voice-generation/generate-voice/parameters",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_description: args.voiceDescription.trim(),
          model_id: "eleven_ttv_v3",
          auto_generate_text: true,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        error: `ElevenLabs design failed: ${res.status} ${text}`,
      };
    }

    const data = (await res.json()) as {
      previews: Array<{ generated_voice_id: string }>;
    };
    const generatedId = data.previews?.[0]?.generated_voice_id;
    if (!generatedId) {
      return { ok: false, error: "No voice preview generated" };
    }

    const createRes = await fetch(
      "https://api.elevenlabs.io/v1/voice-generation/create-voice",
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_name: args.characterId,
          voice_description: args.voiceDescription.trim(),
          generated_voice_id: generatedId,
        }),
      },
    );

    if (!createRes.ok) {
      const text = await createRes.text();
      return {
        ok: false,
        error: `Voice creation failed: ${createRes.status} ${text}`,
      };
    }

    const created = (await createRes.json()) as { voice_id: string };
    const voiceId = created.voice_id;

    // Save to castlist + mark task complete (reuses saveVoiceId logic)
    const saveResult = await saveVoiceId({
      taskId: args.taskId,
      characterId: args.characterId,
      bookId: args.bookId,
      issueId: args.issueId,
      voiceId,
    });

    if (!saveResult.ok) return saveResult;
    return { ok: true, voiceId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
