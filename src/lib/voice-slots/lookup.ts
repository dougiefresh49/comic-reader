/**
 * The `voices` reads that `~/lib/cast`, the TTS settings read and the
 * workflow steps need (#458). This file imports nothing from `~/lib/cast` or
 * ElevenLabs, so the cast module can import it without a cycle and a step
 * bundle pulls in no Node.js-only code. Every voice is found by its row id
 * or its ElevenLabs id, never by `display_name` (decisions row 153).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "~/types/database";

type Client = SupabaseClient;
const db = (client: Client) => client as SupabaseClient<Database>;

function fail(what: string, error: { message: string }): never {
  throw new Error(`voices: ${what}: ${error.message}`);
}

/** The `voices` fields the render chain reads. */
export interface VoiceState {
  id: string;
  current_elevenlabs_id: string | null;
  status: string;
  /** A "this run only" voice: its own issue renders with it, no other issue inherits it (#806). */
  run_only: boolean;
}

/** The `voices` rows these ids name, in chunks that keep the URL short. */
export async function readVoiceStates(
  client: Client,
  ids: Iterable<string>,
): Promise<Map<string, VoiceState>> {
  const list = [...new Set(ids)];
  const out = new Map<string, VoiceState>();
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await db(client)
      .from("voices")
      .select("id, current_elevenlabs_id, status, run_only")
      .in("id", list.slice(i, i + 200));
    if (error) fail("reading voices by id", error);
    for (const v of data ?? []) out.set(v.id, v);
  }
  return out;
}

/**
 * The character's newest `active` voice, or null. A "this run only" voice
 * (`voices.run_only`) is skipped, so a new castlist row never starts with
 * one (#806).
 */
export async function newestActiveVoiceOf(
  client: Client,
  characterId: string,
): Promise<string | null> {
  const { data, error } = await db(client)
    .from("voices")
    .select("id")
    .eq("character_id", characterId)
    .eq("status", "active")
    .eq("run_only", false)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) fail(`reading the voice of ${characterId}`, error);
  return data?.[0]?.id ?? null;
}

/** True when a `voices` row has this id. */
export async function voiceExists(
  client: Client,
  id: string,
): Promise<boolean> {
  const { data, error } = await db(client)
    .from("voices")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) fail(`reading voice ${id}`, error);
  return data !== null;
}

export interface VoiceByElevenLabsId {
  id: string;
  current_elevenlabs_id: string;
  voice_settings: Json | null;
}

/** The `voices` rows that hold these ElevenLabs ids now. */
export async function readVoicesByElevenLabsIds(
  client: Client,
  elevenLabsIds: Iterable<string>,
): Promise<VoiceByElevenLabsId[]> {
  const ids = [...new Set(elevenLabsIds)];
  const out: VoiceByElevenLabsId[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db(client)
      .from("voices")
      .select("id, current_elevenlabs_id, voice_settings")
      .in("current_elevenlabs_id", ids.slice(i, i + 200));
    if (error) fail("reading voices by ElevenLabs id", error);
    for (const v of data ?? [])
      if (v.current_elevenlabs_id)
        out.push({ ...v, current_elevenlabs_id: v.current_elevenlabs_id });
  }
  return out;
}

/** One character's voice state, for the description step and the planners. */
export interface CharacterVoice {
  id: string;
  /** A label only, never matched on. */
  display_name: string;
  character_id: string;
  status: string;
  appearance_id: string | null;
  current_elevenlabs_id: string | null;
  description: string | null;
  created_at: string;
}

/** Every `voices` row filed under these characters. */
export async function readCharacterVoices(
  client: Client,
  characterIds: Iterable<string>,
): Promise<CharacterVoice[]> {
  const ids = [...new Set(characterIds)];
  const out: CharacterVoice[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db(client)
      .from("voices")
      .select(
        "id, display_name, character_id, status, appearance_id, current_elevenlabs_id, description, created_at",
      )
      .in("character_id", ids.slice(i, i + 200));
    if (error) fail("reading the characters' voices", error);
    for (const v of data ?? [])
      if (v.character_id) out.push({ ...v, character_id: v.character_id });
  }
  return out;
}

/**
 * A voice description written before the voice exists (#458): the
 * character's `needs_clip` row with no appearance. Designing the voice makes
 * this same row active.
 */
export const isStoredDesign = (v: {
  status: string;
  appearance_id: string | null;
}): boolean => v.status === "needs_clip" && v.appearance_id === null;

/** Oldest first, then by id: the order that names a character's one stored design row. */
const byAge = (
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * The character's stored design row: the first of its `needs_clip` rows with
 * no appearance, oldest then by id. Two can exist for a moment when two
 * description saves race; every reader and writer takes this same one, so
 * the description, the design claim and the activation land on one row.
 */
export function firstStoredDesign<
  T extends {
    id: string;
    character_id: string | null;
    status: string;
    appearance_id: string | null;
    created_at: string;
  },
>(voices: T[], characterId: string): T | undefined {
  return voices
    .filter((v) => v.character_id === characterId && isStoredDesign(v))
    .sort(byAge)[0];
}

/** The stored design description of each character that has one, by character id. */
export function designDescriptions(
  voices: CharacterVoice[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of new Set(voices.map((v) => v.character_id))) {
    const text = firstStoredDesign(voices, id)?.description?.trim();
    if (text) out.set(id, text);
  }
  return out;
}

/**
 * The description step's write (#458): the character's stored design row
 * (`firstStoredDesign`) takes the text in `description` and `design_prompt`
 * by its id, or a `needs_clip` row with no appearance is inserted when the
 * character has none. Two saves that race can both insert: nothing deletes
 * the second, since a run may already hold its claim (only a partial unique
 * index could prevent it, a schema change). Both rows are harmless, as
 * every reader and `activateDesignedVoice` take `firstStoredDesign` by id.
 * Returns the row written.
 */
export async function saveDesignDescription(
  client: Client,
  input: { characterId: string; displayName: string; description: string },
): Promise<string> {
  const text = {
    description: input.description,
    design_prompt: input.description,
  };
  const what = `storing ${input.characterId}'s description`;
  const writeTo = async (id: string) => {
    const upd = await db(client)
      .from("voices")
      .update(text)
      .eq("id", id)
      .eq("status", "needs_clip")
      .select("id");
    if (upd.error) fail(what, upd.error);
    if ((upd.data ?? []).length === 0)
      throw new Error(`voices: ${what}: ${id} is no longer a stored design`);
    return id;
  };
  const first = async () =>
    firstStoredDesign(
      await readCharacterVoices(client, [input.characterId]),
      input.characterId,
    );
  const held = await first();
  if (held) return writeTo(held.id);
  const ins = await db(client)
    .from("voices")
    .insert({
      ...text,
      display_name: input.displayName,
      character_id: input.characterId,
      status: "needs_clip",
      appearance_id: null,
    })
    .select("id")
    .single();
  if (ins.error) fail(what, ins.error);
  return ins.data.id;
}
