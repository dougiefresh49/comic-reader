/**
 * The planning half of the voice-lab import (#474): voice-lab's clip
 * library index, the current rows and the stored voice lookups in; the
 * ordered writes, the skips, the notes and the voices to describe out. It
 * reads no file, imports no client and makes no network call; the script's
 * apply code is the only thing that runs the writes.
 *
 * Each clip resolves in this order:
 *   stored    its md5 is a voice's source_clip_md5: that voice's. The only
 *             write is a description and labels the voice lacks.
 *   new clip  status approved; the character name resolves through the
 *             name rule, the work id is slugify(title)-year and must be a
 *             works row. Then the appearance (inserted when missing) and the
 *             voice holding it: none, a new archived voice; needs_clip, it
 *             takes the clip; active or archived, a new archived voice with
 *             no appearance and a note.
 * A voice the plan leaves without a description or labels needs a lookup,
 * keyed by its appearance, else by the clip's character and work. With no
 * stored lookup, nothing is written for that voice. A write whose every
 * value is already true is not emitted, so a second run plans nothing.
 */
import path from "node:path";
import { nameResolver, type NamedCharacter } from "~/lib/character-aliases";
import { slugify } from "~/lib/character-id";
import { metadataRefusals } from "~/lib/voice-slots/elevenlabs";
import type { VoiceLabFacts } from "~/lib/voice-slots/import";
import type { VoiceRow } from "~/lib/voice-slots/types";
import type { Database } from "~/types/database";

type Tables = Database["public"]["Tables"];
export type WorkRow = Tables["works"]["Row"];
export type AppearanceRow = Tables["appearances"]["Row"];
export type VoiceLookupRow = Tables["voice_lookups"]["Row"];

/** A voice lookup's key, and an appearance's: one character in one work. */
export interface LookupKey {
  character_id: string;
  work_id: string;
}

export const lookupKeyString = (k: LookupKey) =>
  `${k.character_id}\u0000${k.work_id}`;

/** What the lookup prompt is given about one (character, work). */
export interface LookupSubject {
  key: LookupKey;
  /** The character's display name. */
  character: string;
  work: { title: string; year: number; medium: string };
  voice_actor: string | null;
}

export const INDEX_VERSION = 1;
/** The bucket's allowed_mime_types: mp3, m4a, wav. */
const CLIP_EXTENSIONS = new Set([".mp3", ".m4a", ".wav"]);
const MD5 = /^[a-f0-9]{32}$/;
const SLUG = /^[\w.-]+$/;

/** One row of `index.json`, untrusted until checked. Other fields are ignored. */
export interface IndexClip {
  file?: unknown;
  md5?: unknown;
  character?: unknown;
  work?: {
    slug?: unknown;
    title?: unknown;
    year?: unknown;
    kind?: unknown;
  } | null;
  status?: unknown;
}

export interface LibraryIndex {
  version: number;
  clips: IndexClip[];
}

/** A clip the apply code hashes, uploads, then names on the voice row. */
export interface Clip {
  /** Relative to the library directory. */
  file: string;
  /** Object name in the clips bucket: `<work slug>__<file name>`. */
  object: string;
  md5: string;
}

export interface NewVoice {
  display_name: string;
  character_id: string;
  status: "archived";
  description: string;
  labels: Record<string, string>;
  design_prompt: null;
  starting_pick: false;
  consumers: string[];
  source_clip_path: string;
  source_clip_md5: string;
}

/** `rows` are the 1-based index clips that need the write. */
export type Write =
  | {
      kind: "insert_appearance";
      rows: number[];
      row: LookupKey & { voice_actor: null };
    }
  | {
      kind: "insert_voice";
      rows: number[];
      /** Null beside a voice that holds the appearance; apply resolves the key to an id. */
      appearance: LookupKey | null;
      row: NewVoice;
      clip: Clip;
      /**
       * The earlier clip whose planned voice holds the appearance this voice
       * is planned beside. Apply writes this one only if that clip was written.
       */
      depends_on?: number;
    }
  | {
      kind: "update_voice";
      rows: number[];
      id: string;
      display_name: string;
      set: VoiceLabFacts;
      clip?: Clip;
    };

export interface Skip {
  row: number;
  label: string;
  reason: string;
}

export interface Note {
  row: number;
  text: string;
}

/** A voice the plan describes, and the stored lookup it uses, if any. */
export interface Describe extends LookupSubject {
  row: number;
  /** `<display_name> (<id>)`, or `new "<display_name>"`. */
  voice: string;
  stored: { description: string; labels: Record<string, string> } | null;
  /** Set when a stored lookup fails `metadataRefusals`; `stored` is then null. */
  refused?: string[];
}

export interface Plan {
  writes: Write[];
  skips: Skip[];
  notes: Note[];
  describe: Describe[];
}

export interface PlanInput {
  clips: readonly IndexClip[];
  voices: readonly VoiceRow[];
  works: readonly WorkRow[];
  appearances: readonly AppearanceRow[];
  /** Every `characters` row with its global aliases, for the name rule. */
  characters: readonly NamedCharacter[];
  lookups: readonly VoiceLookupRow[];
  /** Voices no plan may write to. */
  protectedVoiceIds: ReadonlySet<string>;
}

/**
 * The clip an index `file` names, or why it cannot be one: absolute,
 * leaving the library, or a type the bucket refuses.
 */
export function clipFile(file: unknown): { file: string } | { error: string } {
  if (typeof file !== "string" || !file.trim())
    return { error: "file missing or empty" };
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
    return { error: `file is an absolute path: ${file}` };
  const rel = path.posix.normalize(file.replace(/\\/g, "/"));
  if (rel === "." || rel === ".." || rel.startsWith("../"))
    return { error: `file path leaves the library: ${file}` };
  if (!CLIP_EXTENSIONS.has(path.posix.extname(rel).toLowerCase()))
    return { error: `bucket takes mp3, m4a or wav only: ${rel}` };
  return { file: rel };
}

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

const lacksDescription = (v: { description: string | null }) =>
  !isText(v.description);
const lacksLabels = (v: { labels: Record<string, string> | null }) =>
  metadataRefusals({ labels: v.labels }).includes("no labels");

const voiceName = (v: VoiceRow) => `${v.display_name} (${v.id})`;

export function clipLabel(n: number, c: IndexClip): string {
  const name = isText(c.character) ? c.character : "(no character)";
  const file = isText(c.file) ? c.file : "(no file)";
  return `clip ${n} ${name}, ${file}`;
}

export function planVoiceLabImport(input: PlanInput): Plan {
  const appearanceWrites: Write[] = [];
  const voiceWrites: Write[] = [];
  const skips: Skip[] = [];
  const notes: Note[] = [];
  const describe: Describe[] = [];

  const resolve = nameResolver([...input.characters]);
  const worksById = new Map(input.works.map((w) => [w.id, w]));
  const appearanceById = new Map(input.appearances.map((a) => [a.id, a]));
  const appearanceByKey = new Map(
    input.appearances.map((a) => [lookupKeyString(a), a]),
  );
  const voiceByAppearance = new Map(
    input.voices
      .filter((v) => v.appearance_id)
      .map((v) => [v.appearance_id!, v]),
  );
  const lookupByKey = new Map(
    input.lookups.map((l) => [lookupKeyString(l), l]),
  );

  // Targets taken by an earlier clip of this plan, so two clips never write
  // the same voice, appearance or sample.
  const takenVoice = new Map<string, number>();
  /** The voice an earlier clip puts on an appearance, by appearance key. */
  const plannedHolder = new Map<string, { voice: string; clip: number }>();
  const takenMd5 = new Map<string, number>();

  input.clips.forEach((c, i) => {
    const n = i + 1;
    const label = clipLabel(n, c);
    const skip = (reason: string) => skips.push({ row: n, label, reason });
    const note = (text: string) => notes.push({ row: n, text });

    const file = clipFile(c.file);
    if ("error" in file) return skip(file.error);
    if (typeof c.md5 !== "string" || !MD5.test(c.md5))
      return skip("md5 missing or not 32 lowercase hex characters");
    const md5 = c.md5;

    /** The clip's character and work, or the reason one does not resolve. */
    const resolveClip = ():
      | { character: NamedCharacter; work: WorkRow }
      | { error: string } => {
      const name = isText(c.character) ? c.character : "";
      const character = name ? resolve(name) : undefined;
      if (!character)
        return {
          error: `character "${name}" matches no characters row (the import creates no characters)`,
        };
      const w = c.work ?? {};
      if (!isText(w.title) || !Number.isInteger(w.year))
        return { error: "work.title or work.year missing" };
      const workId = `${slugify(w.title)}-${w.year as number}`;
      const work = worksById.get(workId);
      if (!work)
        return {
          error: `work "${w.title}" (${w.year as number}) is not a works row: tried id ${workId} (the import creates no works)`,
        };
      return { character, work };
    };

    /**
     * The stored lookup for `key`, recorded as a voice to describe. Null
     * (after a skip naming --describe) when none is stored yet.
     */
    const lookupFor = (
      key: LookupKey,
      voice: string,
      characterName: string,
    ) => {
      const work = worksById.get(key.work_id)!;
      const row = lookupByKey.get(lookupKeyString(key)) ?? null;
      // A row edited by SQL is checked again before it is copied.
      const refused = row
        ? metadataRefusals({
            description: row.description,
            labels: row.labels as Record<string, string>,
          })
        : [];
      const stored = refused.length > 0 ? null : row;
      describe.push({
        row: n,
        voice,
        key,
        character: characterName,
        work: { title: work.title, year: work.year, medium: work.medium },
        voice_actor:
          appearanceByKey.get(lookupKeyString(key))?.voice_actor ?? null,
        stored: stored
          ? {
              description: stored.description,
              labels: stored.labels as Record<string, string>,
            }
          : null,
        ...(refused.length > 0 ? { refused } : {}),
      });
      if (refused.length > 0)
        skip(
          `the stored lookup for ${key.character_id} in ${key.work_id} is refused (${refused.join(", ")}); fix or delete its voice_lookups row, nothing is written for ${voice} until then`,
        );
      else if (!stored)
        skip(
          `no stored lookup for ${key.character_id} in ${key.work_id}; run --describe first, nothing is written for ${voice} until then`,
        );
      return stored;
    };

    const characterName = (id: string) =>
      input.characters.find((x) => x.id === id)?.display_name ?? id;

    /** The facts write on an existing row, with what it lacks from the lookup. */
    const update = (v: VoiceRow, key: LookupKey, clip?: Clip) => {
      const set: VoiceLabFacts = {};
      if (clip) {
        set.source_clip_path = clip.object;
        set.source_clip_md5 = clip.md5;
        set.status = "archived";
      }
      if (lacksDescription(v) || lacksLabels(v)) {
        const stored = lookupFor(
          key,
          voiceName(v),
          characterName(key.character_id),
        );
        if (!stored) return;
        if (lacksDescription(v)) set.description = stored.description;
        if (lacksLabels(v)) set.labels = stored.labels;
      }
      if (Object.keys(set).length === 0) return;
      takenVoice.set(v.id, n);
      voiceWrites.push({
        kind: "update_voice",
        rows: [n],
        id: v.id,
        display_name: v.display_name,
        set,
        ...(clip ? { clip } : {}),
      });
    };

    /** Why this voice takes no write at all, or null. */
    const refuseVoice = (v: VoiceRow): string | null => {
      if (input.protectedVoiceIds.has(v.id))
        return `protected voice ${voiceName(v)}: the owner's v2 voices take no import writes`;
      const earlier = takenVoice.get(v.id);
      if (earlier)
        return `voice ${voiceName(v)} is already the target of clip ${earlier}`;
      if (!["active", "archived", "needs_clip"].includes(v.status))
        return `voice ${voiceName(v)} has status "${v.status}"`;
      return null;
    };

    // 1. Stored already: the voice holding this md5.
    const holders = input.voices.filter((v) => v.source_clip_md5 === md5);
    if (holders.length > 1)
      return skip(
        `md5 ${md5} is stored on ${holders.length} voices: ${holders.map(voiceName).join(", ")}`,
      );
    const stored = holders[0];
    if (stored) {
      const refused = refuseVoice(stored);
      if (refused) return skip(refused);
      if (!lacksDescription(stored) && !lacksLabels(stored)) return;
      // The key: the voice's own appearance, else the clip's character and work.
      if (stored.appearance_id) {
        const a = appearanceById.get(stored.appearance_id);
        if (!a)
          return skip(
            `${voiceName(stored)} names appearance ${stored.appearance_id}, which is not an appearances row`,
          );
        return update(stored, {
          character_id: a.character_id,
          work_id: a.work_id,
        });
      }
      const r = resolveClip();
      if ("error" in r) return skip(`lookup key: ${r.error}`);
      if (r.character.id !== stored.character_id)
        return skip(
          `lookup key: the clip's character ${r.character.id} is not ${voiceName(stored)}'s character ${stored.character_id ?? "(none)"}`,
        );
      return update(stored, {
        character_id: r.character.id,
        work_id: r.work.id,
      });
    }

    // 2. A new clip.
    if (c.status !== "approved")
      return skip(
        `status "${typeof c.status === "string" ? c.status : ""}" (only approved clips are imported)`,
      );
    const r = resolveClip();
    if ("error" in r) return skip(r.error);
    const slug = c.work?.slug;
    if (typeof slug !== "string" || !SLUG.test(slug) || /^\.+$/.test(slug))
      return skip(`work.slug "${String(slug ?? "")}" is not one folder name`);
    const earlierMd5 = takenMd5.get(md5);
    if (earlierMd5) return skip(`md5 ${md5} is also clip ${earlierMd5}`);
    const key: LookupKey = { character_id: r.character.id, work_id: r.work.id };
    // An earlier clip of this run puts a voice on this appearance: plan what
    // the next run would see, an archived voice holding it.
    const planned = plannedHolder.get(lookupKeyString(key));
    const clip: Clip = {
      file: file.file,
      object: `${slug}__${path.posix.basename(file.file)}`,
      md5,
    };
    const appearance = appearanceByKey.get(lookupKeyString(key));
    const holder = appearance ? voiceByAppearance.get(appearance.id) : null;

    if (holder && !planned) {
      // #469 item 3: the holder must be the clip's character.
      if (holder.character_id !== key.character_id)
        return skip(
          `appearance ${key.character_id} in ${key.work_id} is held by ${voiceName(holder)}, a voice of ${holder.character_id ?? "no character"}`,
        );
      if (holder.status === "needs_clip") {
        const refused = refuseVoice(holder);
        if (refused) return skip(refused);
        const before = voiceWrites.length;
        update(holder, key, clip);
        if (voiceWrites.length > before) {
          takenMd5.set(md5, n);
          plannedHolder.set(lookupKeyString(key), {
            voice: voiceName(holder),
            clip: n,
          });
        }
        return;
      }
      if (holder.status !== "active" && holder.status !== "archived")
        return skip(`voice ${voiceName(holder)} has status "${holder.status}"`);
    }

    // A new archived voice: on the appearance, or beside the voice holding it.
    const displayName = `${r.character.display_name ?? r.character.id} (${r.work.year})`;
    const heldBy = planned
      ? `${planned.voice} (archived, planned by clip ${planned.clip})`
      : holder
        ? `${voiceName(holder)} (${holder.status})`
        : null;
    if (heldBy)
      note(
        `${key.character_id} in ${key.work_id} is held by ${heldBy}; the clip becomes a new archived voice with no appearance`,
      );
    const lookup = lookupFor(
      key,
      `new "${displayName}"`,
      characterName(key.character_id),
    );
    if (!lookup) return;
    takenMd5.set(md5, n);
    if (!heldBy)
      plannedHolder.set(lookupKeyString(key), {
        voice: `"${displayName}"`,
        clip: n,
      });
    if (!heldBy && !appearance)
      appearanceWrites.push({
        kind: "insert_appearance",
        rows: [n],
        row: { ...key, voice_actor: null },
      });
    voiceWrites.push({
      kind: "insert_voice",
      rows: [n],
      appearance: heldBy ? null : key,
      ...(planned ? { depends_on: planned.clip } : {}),
      row: {
        display_name: displayName,
        character_id: key.character_id,
        status: "archived",
        description: lookup.description,
        labels: lookup.labels as Record<string, string>,
        design_prompt: null,
        starting_pick: false,
        consumers: ["comic"],
        source_clip_path: clip.object,
        source_clip_md5: md5,
      },
      clip,
    });
  });

  return {
    writes: [...appearanceWrites, ...voiceWrites],
    skips,
    notes,
    describe,
  };
}

/**
 * The clip `w` depends on, when that clip has failed, else null. Apply runs
 * writes in plan order, so the clip a write depends on is decided first.
 */
export function failedDependency(
  w: Write,
  failedClips: ReadonlySet<number>,
): number | null {
  return w.kind === "insert_voice" &&
    w.depends_on !== undefined &&
    failedClips.has(w.depends_on)
    ? w.depends_on
    : null;
}

/** Apply's "is this write live" decision: its clip and its dependency stand. */
export function liveWrite(w: Write, failedClips: ReadonlySet<number>): boolean {
  return (
    w.rows.some((r) => !failedClips.has(r)) &&
    failedDependency(w, failedClips) === null
  );
}

/** The lookups `--describe` makes: one per key with nothing stored. */
export function lookupsNeeded(plan: Plan): Describe[] {
  const seen = new Set<string>();
  return plan.describe.filter((d) => {
    const k = lookupKeyString(d.key);
    if (d.stored || d.refused || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
