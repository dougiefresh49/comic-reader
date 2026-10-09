"use server";

/**
 * The design sheet's calls (#788). `startDesign` and `voiceOnFile` read
 * only. `draftVoicePrompt` is free when it returns a prompt on file and
 * otherwise makes one logged GEMINI_MEDIUM call; it writes nothing. `generateVoicePreviews` spends
 * ElevenLabs credits (about one per preview-text character for the three
 * takes) and stores the takes' audio in the private previews bucket. No voice
 * is created here: an accepted take is a staged `create_design` move, and
 * `runMoves` saves it at Confirm.
 */
import { createPartFromText } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getGeminiClient } from "~/lib/gemini-client";
import { voiceDescriptionPrompt } from "~/lib/gemini-prompts";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_MEDIUM } from "~/lib/models";
import { supabaseAdmin } from "~/lib/supabase-admin";
import { readCharacterVoices, readVoice } from "~/lib/voice-slots";
import { designPreviews } from "~/lib/voice-slots/design";
import { requireAdmin } from "~/server/admin/require-admin";
import type { Database } from "~/types/database";
import { readSpeakerLines } from "~/workflows/steps/casting-tasks";
import { loadVoiceDescriptionPlanInput } from "~/workflows/steps/voice";
import {
  PREVIEW_MAX,
  PREVIEW_MIN,
  defaultPreviewText,
  previewTextOk,
} from "./preview-text";

const PREVIEWS_BUCKET = "comic-voice-previews";
/** How long a take's signed URL plays, in seconds. */
const TAKE_URL_TTL = 3600;

interface Who {
  bookId: string;
  issueId: string;
  characterId: string;
}

export type DesignResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface DesignStart {
  /** The prompt on file (`design_prompt`, else `description`), or null. */
  prompt: string | null;
  /** What the "From:" line quotes: the `description` on file, else the `design_prompt`, or null. */
  onFile: string | null;
  /** The character's own lines in reading order, padded and capped. */
  previewText: string;
}

export interface Take {
  generated_voice_id: string;
  /** A signed URL to the take's audio, good for an hour. */
  url: string;
}

export interface Takes {
  takes: Take[];
  /** The text the takes say. */
  text: string;
}

function fail(what: string, err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`design a voice, ${what}:`, err);
  return { ok: false, error: message };
}

const deps = () => ({ supabase: supabaseAdmin });

const STATUS_RANK: Record<string, number> = {
  active: 0,
  archived: 1,
  needs_clip: 2,
  library: 3,
};

/**
 * The character's voice text on file, from its `voices` rows (a `needs_clip`
 * stored design counts), its active voice's first, then the newest: the
 * prompt Draft starts from (`design_prompt`, else `description`) and the
 * text the "From:" line quotes (`description`, else `design_prompt`).
 */
async function readOnFile(
  characterId: string,
): Promise<{ prompt: string | null; onFile: string | null }> {
  const voices = await readCharacterVoices(supabaseAdmin, [characterId]);
  const rows = (
    await Promise.all(voices.map((v) => readVoice(supabaseAdmin, v.id)))
  )
    .filter((r) => r !== null)
    .sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
        b.created_at.localeCompare(a.created_at),
    );
  const first = (kind: "design_prompt" | "description") =>
    rows.find((r) => r[kind]?.trim())?.[kind]?.trim() ?? null;
  const prompt = first("design_prompt") ?? first("description");
  const onFile = first("description") ?? first("design_prompt");
  return { prompt, onFile };
}

/** The text on file the "From:" line would quote, for the Voice tab's row. Reads only. */
export async function voiceOnFile(args: {
  characterId: string;
}): Promise<DesignResult<string | null>> {
  try {
    await requireAdmin();
    return { ok: true, data: (await readOnFile(args.characterId)).onFile };
  } catch (err) {
    return fail("reading what is on file", err);
  }
}

/** What the sheet opens with: the prompt on file and the default preview text. Reads only. */
export async function startDesign(
  args: Who,
): Promise<DesignResult<DesignStart>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId } = args;
    const [onFile, lines] = await Promise.all([
      readOnFile(characterId),
      readSpeakerLines(supabaseAdmin, bookId, issueId),
    ]);
    return {
      ok: true,
      data: {
        ...onFile,
        previewText: defaultPreviewText(
          (lines.get(characterId) ?? []).map((l) => l.text),
        ),
      },
    };
  } catch (err) {
    return fail("opening", err);
  }
}

/**
 * Draft: the prompt on file, free, unless `again`; else one GEMINI_MEDIUM
 * call with the pipeline's voice-description prompt over the character's
 * voice snippets from this issue, named as `describeVoices` names it.
 * Writes nothing.
 */
export async function draftVoicePrompt(
  args: Who & { again: boolean },
): Promise<DesignResult<string>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId, again } = args;
    const stored = again ? null : (await readOnFile(characterId)).prompt;
    if (stored) return { ok: true, data: stored };

    const input = await loadVoiceDescriptionPlanInput(
      supabaseAdmin as SupabaseClient<Database>,
      bookId,
      issueId,
    );
    const group = input.groups.find((g) => g.characterId === characterId);
    const snippets = group?.snippets ?? [];
    if (!group || snippets.length === 0)
      return {
        ok: false,
        error: again
          ? "No lines in this issue to draft from"
          : "Nothing on file, and no lines in this issue to draft from",
      };

    const response = await generateContentLogged(
      getGeminiClient(),
      {
        model: GEMINI_MEDIUM,
        contents: [
          // The name `describeVoices` passes: the group's first raw speaker string.
          createPartFromText(
            voiceDescriptionPrompt(group.resolvedName, snippets),
          ),
        ],
      },
      { step: "draft-voice-prompt", bookId, issueId },
    );
    const prompt = response.text?.trim();
    if (!prompt) throw new Error("Gemini returned no draft");
    return { ok: true, data: prompt };
  } catch (err) {
    return fail("drafting", err);
  }
}

/**
 * Three Voice Design takes of the prompt saying the preview text (spends
 * about `previewText.length` credits). Each take's audio goes to the private
 * previews bucket at `<bookId>/<issueId>/<characterId>/<generated_voice_id>.mp3`
 * and comes back as a signed URL. No voice is created and no slot taken.
 */
export async function generateVoicePreviews(
  args: Who & { prompt: string; previewText: string },
): Promise<DesignResult<Takes>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId } = args;
    const prompt = args.prompt.trim();
    if (!prompt) return { ok: false, error: "The prompt is empty" };
    if (!previewTextOk(args.previewText))
      return {
        ok: false,
        error: `The preview text must be ${PREVIEW_MIN}–${PREVIEW_MAX} characters`,
      };

    const { previews, text } = await designPreviews(
      deps(),
      prompt,
      args.previewText,
      { meta: { step: "design-previews", bookId, issueId } },
    );
    const bucket = supabaseAdmin.storage.from(PREVIEWS_BUCKET);
    const takes = await Promise.all(
      previews.map(async (p): Promise<Take> => {
        const path = `${bookId}/${issueId}/${characterId}/${p.generated_voice_id}.mp3`;
        const up = await bucket.upload(
          path,
          Buffer.from(p.audio_base_64, "base64"),
          { contentType: p.media_type, upsert: true },
        );
        if (up.error)
          throw new Error(`storing take ${path}: ${up.error.message}`);
        const signed = await bucket.createSignedUrl(path, TAKE_URL_TTL);
        if (!signed.data?.signedUrl)
          throw new Error(
            `signing take ${path}: ${signed.error?.message ?? "no URL"}`,
          );
        return {
          generated_voice_id: p.generated_voice_id,
          url: signed.data.signedUrl,
        };
      }),
    );
    return { ok: true, data: { takes, text } };
  } catch (err) {
    return fail("generating takes", err);
  }
}
