/**
 * The voice lookup (#474): one `GEMINI_FAST` call per (character, work) that
 * describes how the character sounds in that work, for a voice that has no
 * description or labels. The answer is stored in `voice_lookups`, and the
 * voice-lab import copies it onto the voice row with `--execute`. This module
 * holds the prompt, the answer check and every `voice_lookups` query.
 *
 * The prompt gets the character's name, the work's title, year and medium,
 * and the voice actor when the appearance names one. No audio, no wiki text.
 */
import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateContentLogged } from "~/lib/llm-usage";
import { metadataRefusals } from "~/lib/voice-slots/elevenlabs";
import type { Database, Json } from "~/types/database";
import { GEMINI_FAST } from "../utils/models.js";

/** The `llm_calls.step` of every lookup call. */
export const LOOKUP_STEP = "voice-lab-lookup";

export type VoiceLookupRow =
  Database["public"]["Tables"]["voice_lookups"]["Row"];

export interface LookupKey {
  character_id: string;
  work_id: string;
}

export const lookupKeyString = (k: LookupKey) =>
  `${k.character_id}\u0000${k.work_id}`;

/** What the prompt is given about one (character, work). */
export interface LookupSubject {
  key: LookupKey;
  /** The character's display name. */
  character: string;
  work: { title: string; year: number; medium: string };
  voice_actor: string | null;
}

/**
 * The label vocabulary: the keys and spellings on today's active voices
 * (`age: middle-aged`, `accent: en-new-york`, `language: en`), with the
 * gender and age values ElevenLabs' voice library uses.
 */
export const LABEL_VALUES = {
  gender: ["male", "female", "neutral"],
  age: ["young", "middle-aged", "old"],
} as const;
const ACCENT = /^[a-z]{2}(-[a-z]+)+$/;
const LANGUAGE = /^[a-z]{2}$/;

export interface LookupAnswer {
  /** Who the model says voiced it: printed as a check, not stored. */
  actor: string;
  description: string;
  labels: { gender: string; age: string; accent: string; language: string };
}

const MEDIUM_WORDS: Record<string, string> = {
  movie: "film",
  animated_series: "animated series",
  live_action: "live-action series",
  video_game: "video game",
  comic: "comic",
  podcast: "podcast",
};

export function lookupPrompt(s: LookupSubject): string {
  const medium = MEDIUM_WORDS[s.work.medium] ?? s.work.medium;
  const actor = s.voice_actor ? `\nVoice actor: ${s.voice_actor}` : "";
  return `Describe the speaking voice of one character as it sounds in one work.

Character: ${s.character}
Work: ${s.work.title} (${s.work.year} ${medium})${actor}

Describe this version of the character only. Other films, series and games may give the same character a different voice.

Return JSON:
- actor: the name of the person who voiced this character in this work. Leave it empty if you do not know.
- known: true only if this character appears in this work and you know how they sound in it. If you are not sure, or the character is not in this work, set it to false and leave the other fields empty.
- description: two to four sentences about the voice itself: timbre, pitch, pace and delivery. For example: "A deep, gravelly male voice with a thick Brooklyn accent. It sounds tough and sarcastic, with a fast, clipped delivery." Describe only the sound, not who the character is or what they do. Do not name the actor or the work.
- labels.gender: male, female or neutral.
- labels.age: young, middle-aged or old, by how the voice sounds.
- labels.accent: "en-" and the accent in lowercase words joined by hyphens, such as en-american, en-british, en-new-york or en-japanese.
- labels.language: the two-letter code of the language the character speaks, such as en.`;
}

/** The structured-output schema the call sends. */
export const LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    actor: { type: "string" },
    known: { type: "boolean" },
    description: { type: "string" },
    labels: {
      type: "object",
      properties: {
        gender: { type: "string", enum: [...LABEL_VALUES.gender] },
        age: { type: "string", enum: [...LABEL_VALUES.age] },
        accent: { type: "string" },
        language: { type: "string" },
      },
      required: ["gender", "age", "accent", "language"],
    },
  },
  required: ["actor", "known", "description", "labels"],
} as const;

/** The answer, or why it is not stored. */
export function checkAnswer(
  text: string | undefined,
): LookupAnswer | { refused: string } {
  let raw: {
    actor?: unknown;
    known?: unknown;
    description?: unknown;
    labels?: Record<string, unknown>;
  };
  try {
    raw = JSON.parse(text ?? "") as typeof raw;
  } catch {
    return { refused: "the answer is not JSON" };
  }
  if (raw.known !== true)
    return { refused: "the model says it does not know this voice" };
  // Naming the actor is the check that the model knows this version.
  if (typeof raw.actor !== "string" || !raw.actor.trim())
    return { refused: "the model names no voice actor for this version" };
  const labels = (raw.labels ?? {}) as Record<string, string>;
  const meta = metadataRefusals({
    description: raw.description as string,
    labels,
  });
  if (meta.length > 0) return { refused: meta.join(", ") };
  const wrong = [
    !(LABEL_VALUES.gender as readonly string[]).includes(labels.gender ?? "") &&
      `gender "${labels.gender ?? ""}"`,
    !(LABEL_VALUES.age as readonly string[]).includes(labels.age ?? "") &&
      `age "${labels.age ?? ""}"`,
    !ACCENT.test(labels.accent ?? "") && `accent "${labels.accent ?? ""}"`,
    !LANGUAGE.test(labels.language ?? "") &&
      `language "${labels.language ?? ""}"`,
  ].filter(Boolean);
  if (wrong.length > 0)
    return { refused: `labels outside the vocabulary: ${wrong.join(", ")}` };
  return {
    actor: raw.actor.trim(),
    description: (raw.description as string).trim(),
    labels: {
      gender: labels.gender!,
      age: labels.age!,
      accent: labels.accent!,
      language: labels.language!,
    },
  };
}

type GenerateClient = Pick<GoogleGenAI, "models">;

/**
 * Asks once, and once more when the answer is refused. Stores nothing:
 * the caller decides (`--describe` stores, a prompt trial prints).
 */
export async function lookUpVoice(
  gemini: GenerateClient,
  subject: LookupSubject,
): Promise<
  | { ok: true; answer: LookupAnswer; model: string }
  | { ok: false; reasons: string[] }
> {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateContentLogged(
      gemini,
      {
        model: GEMINI_FAST,
        contents: lookupPrompt(subject),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: LOOKUP_SCHEMA,
        },
      },
      { step: LOOKUP_STEP },
    );
    const answer = checkAnswer(response.text);
    if (!("refused" in answer)) return { ok: true, answer, model: GEMINI_FAST };
    reasons.push(answer.refused);
  }
  return { ok: false, reasons };
}

const PAGE = 1000;
const db = (client: SupabaseClient) => client as SupabaseClient<Database>;

/**
 * Every stored lookup. `missing` is true when the table does not exist yet
 * (the migration is not applied), so a dry run can still print its plan.
 */
export async function readVoiceLookups(
  client: SupabaseClient,
): Promise<{ rows: VoiceLookupRow[]; missing: boolean }> {
  const rows: VoiceLookupRow[] = [];
  for (;;) {
    const { data, error } = await db(client)
      .from("voice_lookups")
      .select("*")
      .order("character_id")
      .order("work_id")
      .range(rows.length, rows.length + PAGE - 1);
    if (error) {
      // PostgREST's "no such table in the schema cache".
      if (error.code === "PGRST205" && rows.length === 0)
        return { rows: [], missing: true };
      throw new Error(`read voice_lookups: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return { rows, missing: false };
  }
}

/** Stores one answer. A key already stored is an error, never a replace. */
export async function insertVoiceLookup(
  client: SupabaseClient,
  key: LookupKey,
  answer: LookupAnswer,
  model: string,
): Promise<void> {
  const { error } = await db(client)
    .from("voice_lookups")
    .insert({
      ...key,
      description: answer.description,
      labels: answer.labels as unknown as Json,
      model,
    });
  if (error)
    throw new Error(
      `insert voice_lookups ${key.character_id} in ${key.work_id}: ${error.message}`,
    );
}
