"use server";

/**
 * The design sheet's calls (#788). `startDesign` and `voiceOnFile` read
 * only. `draftVoicePrompt` is free when it returns a prompt on file and
 * otherwise makes one logged Gemini call: GEMINI_FAST over a picked face
 * (#850), else GEMINI_MEDIUM over the character's voice notes or lines; it
 * writes nothing. `generateVoicePreviews` spends
 * ElevenLabs credits (about one per preview-text character for the three
 * takes) and stores the takes' audio in the private previews bucket. No voice
 * is created here: an accepted take is a staged `create_design` move, and
 * `runMoves` saves it at Confirm.
 */
import { createPartFromBase64, createPartFromText } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readBookFranchises } from "~/lib/cast";
import { readAliases } from "~/lib/character-aliases";
import { slugify } from "~/lib/character-id";
import {
  deckSentence,
  matchCredit,
  parseComicVineCharacters,
} from "~/lib/comicvine";
import { downloadExemplarImage } from "~/lib/exemplar-store";
import { getGeminiClient } from "~/lib/gemini-client";
import {
  faceVoicePrompt,
  voiceDescriptionPrompt,
  type FaceVoiceContext,
} from "~/lib/gemini-prompts";
import { selectIssue } from "~/lib/issue-queries";
import { generateContentLogged } from "~/lib/llm-usage";
import { GEMINI_FAST, GEMINI_MEDIUM } from "~/lib/models";
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
/** The longest preview text `faceVoicePrompt` asks for, in characters. */
const DRAFT_PREVIEW_MAX = 300;

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

export interface Draft {
  prompt: string;
  /** The face draft's preview text, when it was asked for and Gemini gave one. */
  previewText?: string;
  /** Set when the asked-for preview text came back empty or outside its length. */
  previewNote?: string;
  /** The voice snippets or lines a Gemini draft was made from; null for the prompt on file. */
  snippets: string[] | null;
}

const db = () => supabaseAdmin as SupabaseClient<Database>;

/**
 * The character's voice snippets from this issue, with the name
 * `describeVoices` gives them, else its own lines (#811: main cast never
 * gets snippets); both may be empty.
 */
async function readHeard(
  bookId: string,
  issueId: string,
  characterId: string,
): Promise<{ resolvedName: string | null; heard: FaceVoiceContext["heard"] }> {
  const input = await loadVoiceDescriptionPlanInput(db(), bookId, issueId);
  const group = input.groups.find((g) => g.characterId === characterId);
  if (group && group.snippets.length > 0)
    return {
      resolvedName: group.resolvedName,
      heard: { kind: "notes", items: group.snippets },
    };
  const lines = await readSpeakerLines(supabaseAdmin, bookId, issueId);
  return {
    resolvedName: null,
    heard: {
      kind: "lines",
      items: (lines.get(characterId) ?? [])
        .map((l) => l.text)
        .filter((t) => t !== ""),
    },
  };
}

/** `{ prompt, previewText }` out of the face draft's JSON; throws when there is no prompt. */
function parseFaceDraft(text: string | undefined): {
  prompt: string;
  previewText: string;
} {
  const raw = (text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gemini's draft was not JSON");
  }
  const o = (parsed ?? {}) as { prompt?: unknown; previewText?: unknown };
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) throw new Error("Gemini returned no draft");
  const previewText =
    typeof o.previewText === "string" ? o.previewText.trim() : "";
  return { prompt, previewText };
}

/** The issue's wiki qualifier ("villain") for the entry whose name is one of `names`, or null. */
function wikiQualifier(appearances: unknown, names: string[]): string | null {
  const slugs = new Set(names.filter((n) => n !== "").map(slugify));
  for (const entry of Array.isArray(appearances) ? appearances : []) {
    const e = (entry ?? {}) as { name?: unknown; qualifier?: unknown };
    if (typeof e.name !== "string" || !slugs.has(slugify(e.name))) continue;
    if (typeof e.qualifier === "string" && e.qualifier.trim())
      return e.qualifier.trim();
  }
  return null;
}

/**
 * One GEMINI_FAST call over a face crop and what places the character: its
 * names, its franchise (else the book's), the base character of a `form_of`
 * with that one's prompt on file, the issue's wiki qualifier, its Comic Vine
 * deck when one of the issue's credits is this character (#860; the credit's
 * image is never read), and its voice notes or lines when it has any. The
 * exemplar is read by id here and must be this character's; the client sends
 * only the id.
 */
async function draftFromFace(
  args: Who & { exemplarId: string; wantPreviewText: boolean },
): Promise<DesignResult<Draft>> {
  const { bookId, issueId, characterId, exemplarId, wantPreviewText } = args;
  const [exemplar, character, issue, heard, aliases] = await Promise.all([
    db()
      .from("character_face_exemplars")
      .select("character_id, crop_path")
      .eq("id", exemplarId)
      .maybeSingle(),
    db()
      .from("characters")
      .select("display_name, full_name, franchise_id, form_of")
      .eq("id", characterId)
      .maybeSingle(),
    selectIssue(
      supabaseAdmin,
      bookId,
      issueId,
      "wiki_appearances, comicvine_characters",
    ).maybeSingle(),
    readHeard(bookId, issueId, characterId),
    readAliases(supabaseAdmin, [characterId], bookId),
  ]);
  if (exemplar.error) throw new Error(exemplar.error.message);
  if (character.error) throw new Error(character.error.message);
  if (issue.error) throw new Error(issue.error.message);
  if (exemplar.data?.character_id !== characterId)
    return { ok: false, error: "That face is not this character's" };
  const image = await downloadExemplarImage(
    supabaseAdmin,
    exemplar.data.crop_path,
  );
  if (!image) return { ok: false, error: "That face's picture is missing" };

  const row = character.data;
  const displayName = row?.display_name?.trim() ?? "";
  const name =
    heard.resolvedName ?? (displayName.length > 0 ? displayName : characterId);
  const fullName = row?.full_name?.trim() ?? "";

  let franchises: string[] = [];
  if (row?.franchise_id) {
    const f = await db()
      .from("franchises")
      .select("name")
      .eq("id", row.franchise_id)
      .maybeSingle();
    if (f.error) throw new Error(f.error.message);
    if (f.data) franchises = [f.data.name];
  }
  if (franchises.length === 0)
    franchises = (await readBookFranchises(supabaseAdmin, bookId)).map(
      (f) => f.name,
    );

  let base: FaceVoiceContext["base"] = null;
  if (row?.form_of) {
    const [b, onFile] = await Promise.all([
      db()
        .from("characters")
        .select("display_name")
        .eq("id", row.form_of)
        .maybeSingle(),
      readOnFile(row.form_of),
    ]);
    if (b.error) throw new Error(b.error.message);
    const baseName = b.data?.display_name?.trim() ?? "";
    base = {
      name: baseName.length > 0 ? baseName : row.form_of,
      voice: onFile.prompt,
    };
  }

  // Exact names only, as the characters stop matches, so a first-and-last-word
  // guess never hands this character another one's deck.
  const known = [
    characterId,
    displayName,
    fullName,
    name,
    ...(aliases.get(characterId) ?? []),
  ]
    .filter((n) => n !== "")
    .map((n) => ({ name: n, value: true }));
  const credit = (
    parseComicVineCharacters(issue.data?.comicvine_characters) ?? []
  ).find((c) => matchCredit(c, known, true));
  const deck = credit ? deckSentence(credit.deck, 200) : null;

  const prompt = faceVoicePrompt(
    {
      name,
      fullName: fullName && fullName !== name ? fullName : null,
      franchises,
      base,
      qualifier: wikiQualifier(issue.data?.wiki_appearances, [
        characterId,
        displayName,
        fullName,
        name,
      ]),
      deck,
      heard: heard.heard,
    },
    wantPreviewText,
  );
  const response = await generateContentLogged(
    getGeminiClient(),
    {
      model: GEMINI_FAST,
      contents: [
        createPartFromBase64(image.toString("base64"), "image/jpeg"),
        createPartFromText(prompt),
      ],
      config: { responseMimeType: "application/json" },
    },
    { step: "draft-voice-prompt-face", bookId, issueId },
  );
  const draft = parseFaceDraft(response.text);
  const n = draft.previewText.length;
  const previewNote = !wantPreviewText
    ? null
    : n === 0
      ? `The draft gave no preview text; write ${PREVIEW_MIN}+ characters`
      : n < PREVIEW_MIN || n > DRAFT_PREVIEW_MAX
        ? `Draft preview is ${n} characters; edit it to ${PREVIEW_MIN}–${DRAFT_PREVIEW_MAX}`
        : null;
  return {
    ok: true,
    data: {
      prompt: draft.prompt,
      ...(wantPreviewText && n > 0 ? { previewText: draft.previewText } : {}),
      ...(previewNote ? { previewNote } : {}),
      snippets: heard.heard.items,
    },
  };
}

/**
 * Draft: the prompt on file, free, unless `again`. Else, with a face picked
 * (`exemplarId`, #850), one GEMINI_FAST call over that face's crop and what
 * places the character, its voice notes or lines included when it has any;
 * with `wantPreviewText` the same call returns a preview text. With no face,
 * one GEMINI_MEDIUM call with the pipeline's voice-description prompt over
 * the character's voice snippets from this issue, named as `describeVoices`
 * names it; a character with no snippets (#811: main cast never gets them)
 * drafts from its own lines, and one with neither gets an error. Writes
 * nothing.
 */
export async function draftVoicePrompt(
  args: Who & {
    again: boolean;
    /** The picked face: a `character_face_exemplars.id` of this character. */
    exemplarId?: string | null;
    /** The face draft returns a preview text too (the sheet's field is empty). */
    wantPreviewText?: boolean;
  },
): Promise<DesignResult<Draft>> {
  try {
    await requireAdmin();
    const { bookId, issueId, characterId, again } = args;
    const stored = again ? null : (await readOnFile(characterId)).prompt;
    if (stored) return { ok: true, data: { prompt: stored, snippets: null } };

    if (args.exemplarId)
      return await draftFromFace({
        bookId,
        issueId,
        characterId,
        exemplarId: args.exemplarId,
        wantPreviewText: args.wantPreviewText === true,
      });

    const { resolvedName, heard } = await readHeard(
      bookId,
      issueId,
      characterId,
    );
    const snippets = heard.items;
    if (snippets.length === 0)
      return {
        ok: false,
        error: again
          ? "No lines in this issue to draft from"
          : "Nothing on file, and no lines in this issue to draft from",
      };
    let name = resolvedName;
    if (name === null) {
      const { data, error } = await db()
        .from("characters")
        .select("display_name")
        .eq("id", characterId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const displayName = data?.display_name?.trim() ?? "";
      name = displayName.length > 0 ? displayName : characterId;
    }

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
    return { ok: true, data: { prompt, snippets } };
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
