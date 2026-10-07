/**
 * The voice lookup (#474): a `GEMINI_FAST` call per (character, work) that
 * describes how the character sounds in that work, for a voice that has no
 * description or labels. The answer is stored in `voice_lookups`, and the
 * voice-lab import copies it onto the voice row with `--execute`. This module
 * holds the prompt, the answer check and every `voice_lookups` query.
 *
 * The prompt gets the character's name, the work's title, year and medium,
 * and the voice actor when the appearance names one. No wiki text.
 *
 * When the model says it does not know the voice (#552), a second prompt asks
 * it to describe the character's voice from the same franchise's other works,
 * as the actor who plays the character there performs it. That answer names
 * what it was inferred from, and the stored row keeps it in `inferred_from`.
 *
 * Both prompts carry the character's full name beside the display name when
 * the `characters` row has one (#562). When the fallback refuses too and the
 * caller hands over the voice's clip, a third stage sends the clip's audio to
 * `GEMINI_MEDIUM` and asks for the voice heard in it; that answer names no
 * actor, and the stored row's `inferred_from` is `CLIP_MARK`.
 */
import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateContentLogged } from "~/lib/llm-usage";
import { metadataRefusals } from "~/lib/voice-slots/elevenlabs";
import type { Database, Json } from "~/types/database";
import { GEMINI_FAST, GEMINI_MEDIUM } from "../utils/models.js";
import type {
  LookupKey,
  LookupSubject,
  VoiceLookupRow,
} from "./voice-lab-plan.js";

/** The `llm_calls.step` of every lookup call. */
export const LOOKUP_STEP = "voice-lab-lookup";

/**
 * A clip answer's `inferred_from`. Never the clip's file name: object names
 * can carry the clip's source, and run output gets pasted in public. The
 * voice row already holds `source_clip_path`.
 */
export const CLIP_MARK = "clip audio";

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
  /**
   * The actor and works the description was inferred from, when the model did
   * not know this work; `CLIP_MARK` for an answer from the clip's audio. Null
   * for an answer about the work itself.
   */
  inferred_from: string | null;
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

/**
 * The prompt's head: its opening line, then who in which work. The full name
 * follows the display name in parentheses when it says something more.
 */
function subjectLines(s: LookupSubject, opening: string): string {
  const medium = MEDIUM_WORDS[s.work.medium] ?? s.work.medium;
  const actor = s.voice_actor ? `\nVoice actor: ${s.voice_actor}` : "";
  const full = s.full_name?.trim() ?? "";
  const name =
    full && full.toLowerCase() !== s.character.trim().toLowerCase()
      ? `${s.character} (${full})`
      : s.character;
  return `${opening}

Character: ${name}
Work: ${s.work.title} (${s.work.year} ${medium})${actor}`;
}

/** The description and label fields, worded the same in every prompt. */
const DESCRIPTION_FIELDS = `- description: two to four sentences about the voice itself: timbre, pitch, pace and delivery. For example: "A deep, gravelly male voice with a thick Brooklyn accent. It sounds tough and sarcastic, with a fast, clipped delivery." Describe only the sound, not who the character is or what they do. Do not name the actor or the work.
- labels.gender: male, female or neutral.
- labels.age: young, middle-aged or old, by how the voice sounds.
- labels.accent: "en-" and the accent in lowercase words joined by hyphens, such as en-american, en-british, en-new-york or en-japanese.
- labels.language: the two-letter code of the language the character speaks, such as en.`;

/** The direct prompt: the voice in this work, from what the model knows of it. */
export function lookupPrompt(s: LookupSubject): string {
  return `${subjectLines(s, "Describe the speaking voice of one character as it sounds in one work.")}

Describe this version of the character only. Other films, series and games may give the same character a different voice.

Return JSON:
- actor: the name of the person who voiced this character in this work. Leave it empty if you do not know.
- known: true only if this character appears in this work and you know how they sound in it. If you are not sure, or the character is not in this work, set it to false and leave the other fields empty.
${DESCRIPTION_FIELDS}`;
}

/**
 * The fallback prompt, sent only after the direct prompt was refused because
 * the model did not know the voice: the voice from the character's other
 * works in the franchise this work belongs to, where the same actor plays
 * them. It never asks about this work itself.
 */
export function inferencePrompt(s: LookupSubject): string {
  const who = s.voice_actor
    ? `as ${s.voice_actor}, the voice actor named above, performs it.`
    : "as the actor who voices them there performs it. A new work usually keeps the character's current voice actor, so go by that actor's recent performances as this character.";
  return `${subjectLines(s, "Describe the speaking voice of one character from a work you do not know well enough.")}

You do not know this work well enough to describe how the character sounds in it, so do not try. Describe instead the voice this character has in the other films, series and games of the franchise this work belongs to, ${who}

Return JSON:
- actor: the name of the person whose performances as this character you describe. Leave it empty if you do not know.
- inferred_from: one short phrase naming that actor, the character and the other works the voice comes from, such as "Jane Doe as Captain Vega in Star Patrol (2015 film) and Star Patrol Rising (2019 video game)". Name only works other than this one. Leave it empty if you do not know.
- known: true only if this character belongs to the franchise this work belongs to and you know how they sound in its other works. If you are not sure, or the character is from another franchise, set it to false and leave the other fields empty. If you know this work and this character is not in it, set known to false.
${DESCRIPTION_FIELDS}`;
}

/**
 * The clip prompt, sent with the clip's audio after both prompts above were
 * refused: the voice as heard. The character and work only say which speaker
 * to describe; it asks for no actor, so it is not given one.
 */
export function clipPrompt(s: LookupSubject): string {
  return `${subjectLines({ ...s, voice_actor: null }, "Describe the speaking voice heard in this audio clip.")}

The clip is this character speaking in this work. If more than one voice speaks in it, describe this character's voice only; if you cannot tell which voice is the character's, describe the voice that speaks the most. Describe what you hear in the clip, not what you know of the character.

Return JSON:
${DESCRIPTION_FIELDS}`;
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

/** The fallback's schema: the lookup's, plus what the voice was inferred from. */
export const INFERENCE_SCHEMA = {
  ...LOOKUP_SCHEMA,
  properties: {
    ...LOOKUP_SCHEMA.properties,
    inferred_from: { type: "string" },
  },
  required: [...LOOKUP_SCHEMA.required, "inferred_from"],
} as const;

/** The clip stage's schema: the description and labels, no actor, no `known`. */
export const CLIP_SCHEMA = {
  type: "object",
  properties: {
    description: LOOKUP_SCHEMA.properties.description,
    labels: LOOKUP_SCHEMA.properties.labels,
  },
  required: ["description", "labels"],
} as const;

/** Lowercase letters only: "Pat Fraley" and "pat-fraley" read the same. */
const personKey = (name: string) =>
  name.toLowerCase().replace(/[^\p{L}]/gu, "");

/** The same person, loosely: equal, or one name contains the other. */
export function sameActor(a: string, b: string): boolean {
  const x = personKey(a);
  const y = personKey(b);
  return x !== "" && y !== "" && (x.includes(y) || y.includes(x));
}

type RawAnswer = {
  actor?: unknown;
  known?: unknown;
  inferred_from?: unknown;
  description?: unknown;
  labels?: Record<string, unknown>;
};

/** The answer's JSON object, or null when it is not one. */
function parseAnswer(text: string | undefined): RawAnswer | null {
  try {
    const raw = JSON.parse(text ?? "") as unknown;
    return raw && typeof raw === "object" ? (raw as RawAnswer) : null;
  } catch {
    return null;
  }
}

/**
 * The checks every stage's answer passes: `metadataRefusals`, then the label
 * vocabulary. The description and labels, or why they are refused.
 */
function checkDescription(
  raw: RawAnswer,
): Pick<LookupAnswer, "description" | "labels"> | { refused: string } {
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
    description: (raw.description as string).trim(),
    labels: {
      gender: labels.gender!,
      age: labels.age!,
      accent: labels.accent!,
      language: labels.language!,
    },
  };
}

/**
 * The answer, or why it is not stored. `expectedActor` is the appearance's
 * voice actor, when it names one: an answer naming another person is refused.
 * `inferred` checks a fallback answer, which must also name what it was
 * inferred from, and never `work`, the one under lookup: a phrase holding
 * both its title and its year, since a title alone recurs across years
 * ("Teenage Mutant Ninja Turtles" is a 1990 film and a 2012 series). `unknown` marks the
 * refusals that send a key on to the fallback: an answer that is not JSON,
 * the model does not know the voice, or it names no actor for it.
 */
export function checkAnswer(
  text: string | undefined,
  expectedActor: string | null = null,
  inferred = false,
  work: { title: string; year: number } | null = null,
): LookupAnswer | { refused: string; unknown?: true } {
  const raw = parseAnswer(text);
  if (!raw) return { refused: "the answer is not JSON", unknown: true };
  if (raw.known !== true)
    return {
      refused: "the model says it does not know this voice",
      unknown: true,
    };
  // Naming the actor is the check that the model knows this version.
  if (typeof raw.actor !== "string" || !raw.actor.trim())
    return {
      refused: "the model names no voice actor for this version",
      unknown: true,
    };
  if (expectedActor && !sameActor(raw.actor, expectedActor))
    return {
      refused: `the model names ${raw.actor.trim()} as the actor, the appearance names ${expectedActor}`,
    };
  const inferredFrom =
    typeof raw.inferred_from === "string" ? raw.inferred_from.trim() : "";
  if (inferred && !inferredFrom)
    return { refused: "the model names no works the voice is inferred from" };
  const phrase = inferredFrom.toLowerCase();
  if (
    inferred &&
    work?.title.trim() &&
    phrase.includes(work.title.trim().toLowerCase()) &&
    phrase.includes(String(work.year))
  )
    return {
      refused: `the model infers the voice from this work itself: ${inferredFrom}`,
    };
  const heard = checkDescription(raw);
  if ("refused" in heard) return heard;
  return {
    actor: raw.actor.trim(),
    inferred_from: inferred ? inferredFrom : null,
    ...heard,
  };
}

/**
 * A clip answer, or why it is not stored: `checkAnswer`'s JSON, description
 * and label checks, without its actor and inference checks. The answer names
 * no actor, and its `inferred_from` is `CLIP_MARK`.
 */
export function checkClipAnswer(
  text: string | undefined,
): LookupAnswer | { refused: string } {
  const raw = parseAnswer(text);
  if (!raw) return { refused: "the answer is not JSON" };
  const heard = checkDescription(raw);
  if ("refused" in heard) return heard;
  return { actor: "", inferred_from: CLIP_MARK, ...heard };
}

type GenerateClient = Pick<GoogleGenAI, "models">;
type LookupResult =
  | { ok: true; answer: LookupAnswer; model: string }
  | { ok: false; reasons: string[] };

/** A voice's clip, as the clip stage sends it. */
export interface ClipAudio {
  bytes: Uint8Array;
  /** `audio/mpeg` for .mp3, `audio/mp4` for .m4a, `audio/wav` for .wav. */
  mimeType: string;
}

export interface LookupOptions {
  /** The tier of the direct and fallback prompts; `GEMINI_FAST` by default. */
  model?: string;
  /**
   * The voice's clip, called only when the clip stage is reached. Null when
   * the voice has no clip anywhere: the key then stays refused.
   */
  loadClip?: () => Promise<ClipAudio | null>;
}

/** One prompt, asked once and once more when the answer is refused. */
async function askTwice(
  gemini: GenerateClient,
  subject: LookupSubject,
  inferred: boolean,
  model: string = GEMINI_FAST,
): Promise<LookupResult & { unknown?: boolean }> {
  const reasons: string[] = [];
  let unknown = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateContentLogged(
      gemini,
      {
        model,
        contents: inferred ? inferencePrompt(subject) : lookupPrompt(subject),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: inferred ? INFERENCE_SCHEMA : LOOKUP_SCHEMA,
        },
      },
      { step: LOOKUP_STEP },
    );
    const answer = checkAnswer(
      response.text,
      subject.voice_actor,
      inferred,
      subject.work,
    );
    if (!("refused" in answer)) return { ok: true, answer, model };
    reasons.push(answer.refused);
    unknown &&= answer.unknown === true;
  }
  return { ok: false, reasons, unknown };
}

/**
 * The fallback alone: the voice from the character's other works, asked
 * twice. `lookUpVoice` calls it; a prompt trial may call it directly.
 */
export async function inferVoice(
  gemini: GenerateClient,
  subject: LookupSubject,
  model: string = GEMINI_FAST,
): Promise<LookupResult> {
  const result = await askTwice(gemini, subject, true, model);
  return result.ok
    ? result
    : {
        ok: false,
        reasons: result.reasons.map((r) => `from other works, ${r}`),
      };
}

/**
 * The clip stage alone: the clip's audio and `clipPrompt` to `GEMINI_MEDIUM`,
 * asked once and once more when the answer is refused. Never more than two
 * audio calls.
 */
export async function describeFromClip(
  gemini: GenerateClient,
  subject: LookupSubject,
  clip: ClipAudio,
): Promise<LookupResult> {
  const reasons: string[] = [];
  const data = Buffer.from(clip.bytes).toString("base64");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateContentLogged(
      gemini,
      {
        model: GEMINI_MEDIUM,
        contents: [
          {
            role: "user",
            parts: [
              { text: clipPrompt(subject) },
              { inlineData: { mimeType: clip.mimeType, data } },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: CLIP_SCHEMA,
        },
      },
      { step: LOOKUP_STEP },
    );
    const answer = checkClipAnswer(response.text);
    if (!("refused" in answer))
      return { ok: true, answer, model: GEMINI_MEDIUM };
    reasons.push(`from the clip, ${answer.refused}`);
  }
  return { ok: false, reasons };
}

/**
 * Asks about the work twice. When both answers say the model does not know
 * the voice, asks the fallback twice. When the fallback refuses too and
 * `loadClip` hands over the voice's clip, asks the clip stage: at most six
 * calls, two of them audio. Stores nothing: the caller decides (`--describe`
 * stores, a prompt trial prints). `reasons` holds every refusal in order; the
 * returned `model` is the one that answered.
 */
export async function lookUpVoice(
  gemini: GenerateClient,
  subject: LookupSubject,
  options: LookupOptions = {},
): Promise<LookupResult> {
  const direct = await askTwice(gemini, subject, false, options.model);
  if (direct.ok) return direct;
  // An actor contradicting the appearance, or a known voice whose description
  // or labels fail the checks, is not a gap in what the model knows, so the
  // fallback would not fix it.
  if (!direct.unknown) return { ok: false, reasons: direct.reasons };
  const inferred = await inferVoice(gemini, subject, options.model);
  if (inferred.ok) return inferred;
  const reasons = [...direct.reasons, ...inferred.reasons];
  if (!options.loadClip) return { ok: false, reasons };
  const clip = await options.loadClip();
  if (!clip)
    return {
      ok: false,
      reasons: [...reasons, "no clip to describe the voice from"],
    };
  const heard = await describeFromClip(gemini, subject, clip);
  if (heard.ok) return heard;
  return { ok: false, reasons: [...reasons, ...heard.reasons] };
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
      inferred_from: answer.inferred_from,
      model,
    });
  if (error)
    throw new Error(
      `insert voice_lookups ${key.character_id} in ${key.work_id}: ${error.message}`,
    );
}
