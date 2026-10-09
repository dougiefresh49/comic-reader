"use server";

/**
 * The design sheet's calls (#788). `startDesign` reads only. `draftVoicePrompt`
 * is free when it returns a prompt on file and otherwise makes one logged
 * GEMINI_MEDIUM call; it writes nothing. `generateVoicePreviews` spends
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

/** Where a draft came from, for the sheet's "From:" line. */
export type DraftSource =
  | { kind: "design_prompt" | "description"; voiceName: string }
  | { kind: "gemini"; snippets: number };

export interface Draft {
  prompt: string;
  source: DraftSource;
}

export interface DesignStart {
  /** The prompt on file, or null when there is none. */
  draft: Draft | null;
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

/** The character's `design_prompt` on file, else its `description`: its active voice's first, then the newest. */
async function storedDraft(characterId: string): Promise<Draft | null> {
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
  for (const kind of ["design_prompt", "description"] as const) {
    const row = rows.find((r) => r[kind]?.trim());
    if (row)
      return {
        prompt: row[kind]!.trim(),
        source: { kind, voiceName: row.display_name },
      };
  }
  return null;
}

/** What the sheet opens with: the prompt on file and the default preview text. Reads only. */
export async function startDesign(
  args: Who,
): Promise<DesignResult<DesignStart>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId } = args;
    const [draft, lines] = await Promise.all([
      storedDraft(characterId),
      readSpeakerLines(supabaseAdmin, bookId, issueId),
    ]);
    return {
      ok: true,
      data: {
        draft,
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
 * call with the voice-description prompt over the character's voice
 * snippets from this issue. Writes nothing.
 */
export async function draftVoicePrompt(
  args: Who & { again: boolean },
): Promise<DesignResult<Draft>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId, again } = args;
    const stored = again ? null : await storedDraft(characterId);
    if (stored) return { ok: true, data: stored };

    const input = await loadVoiceDescriptionPlanInput(
      supabaseAdmin as SupabaseClient<Database>,
      bookId,
      issueId,
    );
    const snippets =
      input.groups.find((g) => g.characterId === characterId)?.snippets ?? [];
    if (snippets.length === 0)
      return {
        ok: false,
        error: again
          ? "No lines in this issue to draft from"
          : "Nothing on file, and no lines in this issue to draft from",
      };

    const { data: row, error } = await supabaseAdmin
      .from("characters")
      .select("display_name")
      .eq("id", characterId)
      .maybeSingle();
    if (error) throw new Error(`reading ${characterId}: ${error.message}`);
    const name =
      (row as { display_name: string | null } | null)?.display_name ??
      characterId;

    const response = await generateContentLogged(
      getGeminiClient(),
      {
        model: GEMINI_MEDIUM,
        contents: [createPartFromText(voiceDescriptionPrompt(name, snippets))],
      },
      { step: "draft-voice-prompt", bookId, issueId },
    );
    const prompt = response.text?.trim();
    if (!prompt) throw new Error("Gemini returned no draft");
    return {
      ok: true,
      data: { prompt, source: { kind: "gemini", snippets: snippets.length } },
    };
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
