"use server";

import { GoogleGenAI, createPartFromText } from "@google/genai";
import { revalidatePath } from "next/cache";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { updateIssue } from "~/lib/issue-queries";
import {
  type CastSaveFailure,
  castSaveFailureMessage,
  registerCastVoice,
} from "./voice-registry";

const SKIPPED_VOICE = "__SKIPPED__";

type ActionResult = { ok: true } | { ok: false; error: string };

type CompleteCastingResult =
  | { ok: true; resumed: boolean }
  | { ok: false; error: string };

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
 * Shared by the paste and Voice Design paths: marks the chosen appearance,
 * registers the voice on the castlist, and completes the casting task.
 */
async function saveCastVoice(
  args: SaveVoiceIdArgs & { designPrompt?: string },
): Promise<{ ok: true } | CastSaveFailure> {
  const voiceId = args.voiceId.trim();

  if (args.appearanceId) {
    const { error } = await supabaseAdmin
      .from("character_appearances")
      .update({
        voice_id: voiceId,
        voice_status: "ready",
        voice_model_status: "ready",
      })
      .eq("id", args.appearanceId);
    if (error) return { ok: false, error: error.message, stage: "none" };
  }

  const registered = await registerCastVoice(supabaseAdmin, {
    bookId: args.bookId,
    issueId: args.issueId,
    characterId: args.characterId,
    elevenLabsId: voiceId,
    designPrompt: args.designPrompt,
  });
  if (!registered.ok) return registered;

  const { error: taskErr } = await supabaseAdmin
    .from("casting_tasks")
    .update({
      status: "complete",
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.taskId);
  if (taskErr) {
    return {
      ok: false,
      error: taskErr.message,
      stage: "castlist",
      voiceUuid: registered.voiceUuid,
    };
  }

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true };
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
  const res = await saveCastVoice(args);
  if (res.ok) return res;
  return {
    ok: false,
    error: castSaveFailureMessage(args.voiceId.trim(), res),
  };
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
  // voice_uuid is cleared so voice rotation never restores a voice over the skip.
  const { error: castErr } = await supabaseAdmin.from("castlist").upsert(
    {
      book_id: args.bookId,
      issue_id: args.issueId,
      character: args.characterId,
      voice_id: SKIPPED_VOICE,
      voice_uuid: null,
    },
    { onConflict: "book_id,issue_id,character" },
  );
  if (castErr) return { ok: false, error: castErr.message };

  const { error: taskErr } = await supabaseAdmin
    .from("casting_tasks")
    .update({
      status: "skipped",
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.taskId);
  if (taskErr) return { ok: false, error: taskErr.message };

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
 * All casting tasks are done (complete or skipped). Clear the casting
 * pause and resume a live workflow hook when one is waiting.
 */
export async function completeCasting(
  args: CompleteCastingArgs,
): Promise<CompleteCastingResult> {
  const { data: remaining, error: remainingErr } = await supabaseAdmin
    .from("casting_tasks")
    .select("id")
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("status", "pending");

  if (remainingErr) {
    return { ok: false, error: remainingErr.message };
  }

  if (remaining && remaining.length > 0) {
    return {
      ok: false,
      error: `${remaining.length} task(s) still pending`,
    };
  }

  const { error: pauseErr } = await updateIssue(
    supabaseAdmin,
    args.bookId,
    args.issueId,
    {
      pipeline_paused: false,
      pipeline_paused_at: null,
      pipeline_paused_url: null,
    },
  ).in("pipeline_paused_at", ["casting", "find-voice-sources"]);

  if (pauseErr) {
    return { ok: false, error: pauseErr.message };
  }

  let resumed = false;
  try {
    await resumeHook(`ingest:${args.bookId}/${args.issueId}/casting`, {
      approved: true,
    });
    resumed = true;
  } catch (err) {
    // Only a missing hook means no live run was waiting (same case the
    // resume-hook route maps to 404 / "Hook not found").
    if (
      HookNotFoundError.is(err) ||
      (err instanceof Error && /hook not found/i.test(err.message))
    ) {
      resumed = false;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true, resumed };
}

/** POST /v1/text-to-voice/design, the fields read here. */
interface TextToVoiceDesignResponse {
  previews?: Array<{ generated_voice_id: string }>;
}

/** POST /v1/text-to-voice, the fields read here. */
interface TextToVoiceCreateResponse {
  voice_id: string;
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
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ELEVENLABS_API_KEY not configured" };
  }
  const prompt = args.voiceDescription.trim();

  try {
    const designRes = await fetch(
      "https://api.elevenlabs.io/v1/text-to-voice/design",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_description: prompt,
          model_id: "eleven_ttv_v3",
          auto_generate_text: true,
        }),
      },
    );

    if (!designRes.ok) {
      const text = await designRes.text();
      return {
        ok: false,
        error: `ElevenLabs design failed: ${designRes.status} ${text}`,
      };
    }

    const design = (await designRes.json()) as TextToVoiceDesignResponse;
    const generatedId = design.previews?.[0]?.generated_voice_id;
    if (!generatedId) {
      return { ok: false, error: "No voice preview generated" };
    }

    const createRes = await fetch(
      "https://api.elevenlabs.io/v1/text-to-voice",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voice_name: args.characterId,
          voice_description: prompt,
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

    const { voice_id: voiceId } =
      (await createRes.json()) as TextToVoiceCreateResponse;

    const saveResult = await saveCastVoice({
      taskId: args.taskId,
      characterId: args.characterId,
      bookId: args.bookId,
      issueId: args.issueId,
      voiceId,
      designPrompt: prompt,
    });

    if (!saveResult.ok) {
      // The voice already holds an ElevenLabs slot: return, log and name its id.
      const row = saveResult.voiceUuid
        ? ` voices_row=${saveResult.voiceUuid}`
        : "";
      console.error(
        `[casting] Voice Design save failed: book=${args.bookId} issue=${args.issueId} character=${args.characterId} voice=${voiceId} stage=${saveResult.stage}${row}: ${saveResult.error}`,
      );
      return {
        ok: false,
        voiceId,
        error: `${castSaveFailureMessage(voiceId, saveResult)} Running Voice Design again creates a second voice and takes another slot.`,
      };
    }
    return { ok: true, voiceId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

interface MediaAppearance {
  mediaTitle: string;
  year: number;
  voiceActor: string;
  mediaType: string;
  youtubeSearchTerms: string[];
  notes: string;
}

interface ResearchCharacterArgs {
  characterId: string;
  franchise?: string;
}

/**
 * On-demand Gemini research for a single character.
 * Looks up voice actors and media appearances, writes results to
 * character_appearances table.
 */
export async function researchCharacter(
  args: ResearchCharacterArgs,
): Promise<ActionResult & { appearances?: MediaAppearance[] }> {
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY not configured" };
  }

  const franchise = args.franchise ?? "unknown franchise";
  const prompt = `What animated series, movies, video games, or live-action productions has the character "${args.characterId}" from "${franchise}" appeared in with voiced dialogue?

For each appearance, return:
- mediaTitle: name of the show/movie/game
- year: release year
- voiceActor: name of voice actor
- mediaType: "animated_series" | "movie" | "video_game" | "live_action"
- youtubeSearchTerms: 2-3 good search queries to find clips on YouTube
- notes: any relevant context (e.g., "original voice actor", "reboot", "cameo only")

Return as a JSON array only, with no markdown formatting or extra text.`;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: GEMINI_MEDIUM,
      contents: [createPartFromText(prompt)],
    });

    const text = response.text?.trim();
    if (!text) return { ok: false, error: "Empty Gemini response" };

    let jsonText = text;
    const codeBlock = /```(?:json)?\n?([\s\S]*?)\n?```/.exec(jsonText);
    if (codeBlock?.[1]) jsonText = codeBlock[1].trim();

    let appearances: MediaAppearance[];
    try {
      appearances = JSON.parse(jsonText) as MediaAppearance[];
    } catch {
      return { ok: false, error: "Failed to parse Gemini response as JSON" };
    }

    // Write to character_appearances
    for (const app of appearances) {
      const id = `${args.characterId}-${app.mediaTitle}-${app.year}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 80);

      const { error } = await supabaseAdmin
        .from("character_appearances")
        .upsert(
          {
            id,
            character_id: args.characterId,
            media_title: app.mediaTitle,
            year: app.year,
            voice_actor: app.voiceActor,
            media_type: app.mediaType,
            youtube_search_terms: app.youtubeSearchTerms,
            notes: app.notes,
            voice_model_status: "pending",
          },
          { onConflict: "id" },
        );
      if (error) {
        return {
          ok: false,
          error: `character_appearances upsert failed: ${error.message}`,
        };
      }
    }

    revalidatePath("/admin/characters/casting", "page");
    return { ok: true, appearances };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

interface BulkVoiceDesignArgs {
  tasks: Array<{
    taskId: string;
    characterId: string;
    bookId: string;
    issueId: string;
    voiceDescription: string;
  }>;
}

/**
 * Batch Voice Design for multiple characters at once.
 * Used for minor/generic characters that don't need manual sourcing.
 */
export async function bulkVoiceDesign(args: BulkVoiceDesignArgs): Promise<
  ActionResult & {
    results?: Array<{
      characterId: string;
      ok: boolean;
      voiceId?: string;
      error?: string;
    }>;
  }
> {
  const results: Array<{
    characterId: string;
    ok: boolean;
    voiceId?: string;
    error?: string;
  }> = [];

  for (const task of args.tasks) {
    const res = await createVoiceDesign(task);
    results.push({
      characterId: task.characterId,
      ok: res.ok,
      // Set on a failure too when the voice was created before the save failed.
      voiceId: res.voiceId,
      error: res.ok ? undefined : res.error,
    });
  }

  revalidatePath("/admin/characters/casting", "page");
  revalidatePath("/admin", "page");
  return { ok: true, results };
}
