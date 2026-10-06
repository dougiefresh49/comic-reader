/**
 * The planning half of the voice-lab import (#467): a version 2 manifest
 * and the current rows in, an ordered list of typed writes, the skipped
 * rows and the notes out. It reads no file and touches no client; the
 * script's apply code is the only thing that runs the writes.
 *
 * The rule for each manifest row is the field table in
 * docs/casting-data-model.html ("Voice-lab handoff") as #467 settles it:
 * a row with `voice_uuid` updates that voice; a clone (`work`) resolves
 * work, then appearance (character_id, work_id), then the voice holding
 * the appearance; a designed voice (`design_prompt`) matches on
 * (character_id, md5) among voices with no appearance. A write whose every
 * value is already true is not emitted, so a second run plans nothing.
 */
import path from "node:path";
import { metadataRefusals } from "~/lib/voice-slots/elevenlabs";
import type { VoiceLabFacts } from "~/lib/voice-slots/import";
import { firstStoredDesign } from "~/lib/voice-slots/lookup";
import type { VoiceRow } from "~/lib/voice-slots/types";
import type { Database } from "~/types/database";

type Tables = Database["public"]["Tables"];
export type WorkRow = Tables["works"]["Row"];
export type AppearanceRow = Tables["appearances"]["Row"];

export const MANIFEST_VERSION = 2;
const IMPORTED_STATUSES = new Set(["approved", "ready to clone"]);
/** The bucket's allowed_mime_types: mp3, m4a, wav. */
const CLIP_EXTENSIONS = new Set([".mp3", ".m4a", ".wav"]);
const MD5 = /^[a-f0-9]{32}$/;

/** One row of `casting/<folder>/voices.json`, untrusted until checked. */
export interface ManifestRow {
  character_id?: string;
  voice_uuid?: string;
  work?: {
    id?: string;
    title?: string;
    year?: number;
    medium?: string;
    franchise_id?: string | null;
  } | null;
  voice_actor?: string | null;
  design_prompt?: string | null;
  file?: string;
  md5?: string;
  description?: string;
  labels?: Record<string, string>;
  starting_pick?: boolean;
  consumers?: string[];
  status?: string;
}

export interface Manifest {
  version: number;
  voices: ManifestRow[];
}

/** A clip the apply code hashes, uploads, then names on the voice row. */
export interface Clip {
  /** Relative to clone-sources/<folder>/. */
  file: string;
  /** Object name in the clips bucket: `<folder>__<file with / as __>`. */
  object: string;
  md5: string;
}

export interface AppearanceKey {
  character_id: string;
  work_id: string;
}

export interface NewVoice {
  display_name: string;
  character_id: string;
  status: "archived";
  description: string;
  labels: Record<string, string>;
  design_prompt: string | null;
  starting_pick: boolean;
  consumers: string[];
  source_clip_path: string;
  source_clip_md5: string;
}

/** `rows` are the 1-based manifest rows that need the write. */
export type Write =
  | {
      kind: "insert_work";
      rows: number[];
      row: {
        id: string;
        title: string;
        year: number;
        medium: string;
        franchise_id: string | null;
      };
    }
  | {
      kind: "insert_appearance";
      rows: number[];
      row: AppearanceKey & { voice_actor: string | null };
    }
  | {
      kind: "insert_voice";
      rows: number[];
      /** Null for a designed voice; apply resolves the key to an id. */
      appearance: AppearanceKey | null;
      row: NewVoice;
      clip: Clip;
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

export interface Plan {
  writes: Write[];
  skips: Skip[];
  notes: Note[];
}

export interface PlanInput {
  folder: string;
  manifest: Manifest;
  voices: readonly VoiceRow[];
  works: readonly WorkRow[];
  appearances: readonly AppearanceRow[];
  /** Every `characters` id, with its display name for a new row's label. */
  characters: ReadonlyMap<string, string | null>;
  franchiseIds: ReadonlySet<string>;
  /** The `works.medium` check set. */
  media: ReadonlySet<string>;
  /** Voices no plan may write to, whichever route a row takes. */
  protectedVoiceIds: ReadonlySet<string>;
}

/**
 * The clip a manifest `file` names, or why it cannot be one: absolute,
 * leaving the folder, or a type the bucket refuses.
 */
export function clipObject(
  folder: string,
  file: unknown,
): { file: string; object: string } | { error: string } {
  if (typeof file !== "string" || !file.trim())
    return { error: "file missing or empty" };
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
    return { error: `file is an absolute path: ${file}` };
  const rel = path.posix.normalize(file.replace(/\\/g, "/"));
  if (rel === "." || rel === ".." || rel.startsWith("../"))
    return { error: `file path leaves the ${folder} folder: ${file}` };
  if (!CLIP_EXTENSIONS.has(path.posix.extname(rel).toLowerCase()))
    return { error: `bucket takes mp3, m4a or wav only: ${rel}` };
  return { file: rel, object: `${folder}__${rel.split("/").join("__")}` };
}

const present = <T>(v: T | null | undefined): v is T =>
  v !== undefined && v !== null;

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

function sameLabels(
  a: Record<string, string> | null,
  b: Record<string, string> | null,
): boolean {
  const flat = (l: Record<string, string> | null) =>
    JSON.stringify(
      Object.entries(l ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)),
    );
  return a !== null && b !== null && flat(a) === flat(b);
}

/** The same values, ignoring order and repeats. */
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

const voiceName = (v: VoiceRow) => `${v.display_name} (${v.id})`;

export function rowLabel(n: number, m: ManifestRow): string {
  const what = present(m.voice_uuid)
    ? `voice ${m.voice_uuid}`
    : present(m.work)
      ? `work ${m.work.id ?? "?"}`
      : present(m.design_prompt)
        ? "design"
        : "no work or design";
  return `row ${n} ${m.character_id ?? "(no character_id)"}, ${what}, ${m.file ?? "(no file)"}`;
}

/** Why a row cannot be imported at all, before any matching, or null. */
function refusal(
  m: ManifestRow,
  input: PlanInput,
  clip: ReturnType<typeof clipObject>,
): string | null {
  if (!isText(m.character_id)) return "character_id missing";
  if (!input.characters.has(m.character_id))
    return `character_id "${m.character_id}" is not in characters (the import creates no characters)`;
  if (!IMPORTED_STATUSES.has(m.status ?? ""))
    return `status "${m.status ?? ""}" (only approved or ready to clone are imported)`;
  const clone = present(m.work);
  const design = present(m.design_prompt);
  if (clone && design)
    return "both work and design_prompt are present; a row is a clone or a design";
  if (!clone && !design) return "neither work nor design_prompt is present";
  if (design && !isText(m.design_prompt)) return "design_prompt is empty";
  if ("error" in clip) return clip.error;
  if (typeof m.md5 !== "string" || !MD5.test(m.md5))
    return "md5 missing or not 32 lowercase hex characters";
  const meta = metadataRefusals({
    description: m.description,
    labels: m.labels,
  });
  if (meta.includes("no description")) return "description missing or empty";
  if (meta.includes("no labels")) return "labels missing or empty";
  if (present(m.starting_pick) && typeof m.starting_pick !== "boolean")
    return "starting_pick is not true or false";
  if (
    present(m.consumers) &&
    (!Array.isArray(m.consumers) || !m.consumers.every(isText))
  )
    return "consumers is not a list of names";
  if (clone) {
    const w = m.work!;
    if (!isText(w.id) || !isText(w.title) || !Number.isInteger(w.year))
      return "work.id, work.title or work.year missing";
    if (!input.media.has(w.medium ?? ""))
      return `work.medium "${w.medium ?? ""}" is not a works.medium (${[...input.media].join(", ")})`;
    if (present(w.franchise_id) && !input.franchiseIds.has(w.franchise_id))
      return `work.franchise_id "${w.franchise_id}" is not in franchises (the import creates no franchises)`;
  }
  return null;
}

export function planVoiceLabImport(input: PlanInput): Plan {
  const works: Write[] = [];
  const appearanceWrites: Write[] = [];
  const voiceWrites: Write[] = [];
  const skips: Skip[] = [];
  const notes: Note[] = [];

  const voicesById = new Map(input.voices.map((v) => [v.id, v]));
  const voiceByAppearance = new Map(
    input.voices
      .filter((v) => v.appearance_id)
      .map((v) => [v.appearance_id!, v]),
  );
  const worksById = new Map(input.works.map((w) => [w.id, w]));
  const appKey = (k: AppearanceKey) => `${k.character_id}\u0000${k.work_id}`;
  const appearanceByKey = new Map(input.appearances.map((a) => [appKey(a), a]));

  // Targets taken by an earlier row of this plan, so two rows never write
  // the same voice, appearance or clip.
  const takenVoice = new Map<string, number>();
  const takenAppearance = new Map<string, number>();
  const takenMd5 = new Map<string, number>();
  const plannedWork = new Map<
    string,
    Extract<Write, { kind: "insert_work" }>
  >();

  /** The voice or earlier row already holding this md5, other than `self`. */
  const md5Holder = (md5: string, self?: string): string | null => {
    const v = input.voices.find(
      (x) => x.source_clip_md5 === md5 && x.id !== self,
    );
    if (v) return `voice ${voiceName(v)}`;
    const n = takenMd5.get(md5);
    return n ? `row ${n} of this manifest` : null;
  };

  input.manifest.voices.forEach((m, i) => {
    const n = i + 1;
    const label = rowLabel(n, m);
    const skip = (reason: string) => skips.push({ row: n, label, reason });
    const note = (text: string) => notes.push({ row: n, text });
    const clip = clipObject(input.folder, m.file);
    const refused = refusal(m, input, clip);
    if (refused) return skip(refused);
    const c = clip as { file: string; object: string };
    const md5 = m.md5!;
    const characterId = m.character_id!;
    const sample: Clip = { file: c.file, object: c.object, md5 };

    /** The facts update on an existing row; a skip when it may take none. */
    const update = (v: VoiceRow) => {
      if (input.protectedVoiceIds.has(v.id))
        return skip(
          `protected voice ${voiceName(v)}: the owner's v2 voices take no import writes`,
        );
      const earlier = takenVoice.get(v.id);
      if (earlier)
        return skip(
          `voice ${voiceName(v)} is already the target of row ${earlier}`,
        );
      if (!["active", "archived", "needs_clip"].includes(v.status))
        return skip(`voice ${voiceName(v)} has status "${v.status}"`);
      // A sample write needs the clip unheld elsewhere; a different stored
      // md5 is the note below instead.
      // Different: another md5, or (older rows, md5 never filled) a path
      // that is not this row's object name. A matching path with no md5
      // takes the md5 only; uploadClip's byte check guards it.
      const differentSample =
        v.source_clip_md5 !== null
          ? v.source_clip_md5 !== md5
          : v.source_clip_path !== null && v.source_clip_path !== c.object;
      const needsSample =
        !differentSample && (!v.source_clip_path || !v.source_clip_md5);
      const holder = needsSample ? md5Holder(md5, v.id) : null;
      if (holder)
        return skip(
          `md5 ${md5} is already stored on ${holder}; name that voice with voice_uuid`,
        );
      takenVoice.set(v.id, n);

      const set: VoiceLabFacts = {};
      if (m.description !== v.description) set.description = m.description!;
      if (!sameLabels(m.labels!, v.labels)) set.labels = m.labels!;
      if (present(m.design_prompt) && m.design_prompt !== v.design_prompt)
        set.design_prompt = m.design_prompt;
      if (present(m.starting_pick) && m.starting_pick !== v.starting_pick)
        set.starting_pick = m.starting_pick;
      if (present(m.consumers)) {
        const merged = [...new Set([...v.consumers, ...m.consumers])];
        if (!sameSet(merged, v.consumers)) set.consumers = merged;
      }
      if (needsSample) {
        if (v.source_clip_path !== c.object) set.source_clip_path = c.object;
        if (v.source_clip_md5 !== md5) set.source_clip_md5 = md5;
        takenMd5.set(md5, n);
      } else if (differentSample)
        note(
          `${voiceName(v)} stores a different sample (${v.source_clip_md5 !== null ? `md5 ${v.source_clip_md5}` : `path ${v.source_clip_path}, no md5`}, manifest ${md5}); the stored sample is left alone, and a new clip is a new voice`,
        );
      // archived means a sample is stored: a needs_clip row moves once it
      // holds both a path and an md5.
      const pathAfter = set.source_clip_path ?? v.source_clip_path;
      const md5After = set.source_clip_md5 ?? v.source_clip_md5;
      if (v.status === "needs_clip" && pathAfter && md5After)
        set.status = "archived";
      if (Object.keys(set).length === 0) return;
      voiceWrites.push({
        kind: "update_voice",
        rows: [n],
        id: v.id,
        display_name: v.display_name,
        set,
        ...(needsSample ? { clip: sample } : {}),
      });
    };

    /** A new archived row with the sample; a skip when the clip is held. */
    const insert = (
      appearance: AppearanceKey | null,
      displayName: string,
      before?: () => void,
    ) => {
      const holder = md5Holder(md5);
      if (holder)
        return skip(
          `md5 ${md5} is already stored on ${holder}; name that voice with voice_uuid`,
        );
      before?.();
      takenMd5.set(md5, n);
      voiceWrites.push({
        kind: "insert_voice",
        rows: [n],
        appearance,
        row: {
          display_name: displayName,
          character_id: characterId,
          status: "archived",
          description: m.description!,
          labels: m.labels!,
          design_prompt: present(m.design_prompt) ? m.design_prompt : null,
          starting_pick: m.starting_pick ?? false,
          consumers: present(m.consumers)
            ? [...new Set(m.consumers)]
            : ["comic"],
          source_clip_path: c.object,
          source_clip_md5: md5,
        },
        clip: sample,
      });
    };

    const characterName = input.characters.get(characterId) ?? characterId;

    // 1. voice_uuid: that row and no other matching.
    if (present(m.voice_uuid)) {
      const v = voicesById.get(m.voice_uuid);
      if (!v) return skip(`voice_uuid ${m.voice_uuid} is not a voices row`);
      if (v.character_id !== characterId)
        return skip(
          `voice_uuid names ${voiceName(v)}, a voice of ${v.character_id ?? "no character"}, not ${characterId}`,
        );
      return update(v);
    }

    // 2. A clone: work, then appearance, then the voice holding it.
    if (present(m.work)) {
      const w = m.work as Required<NonNullable<ManifestRow["work"]>>;
      const work = worksById.get(w.id);
      if (work) {
        const diffs = (["title", "year", "medium"] as const)
          .filter((k) => work[k] !== w[k])
          .map((k) => `${k} "${work[k]}" (manifest "${w[k]}")`);
        if (diffs.length > 0)
          note(
            `work ${w.id} is stored with ${diffs.join(", ")}; the works row is left as it is`,
          );
      }
      const key = { character_id: characterId, work_id: w.id };
      const earlier = takenAppearance.get(appKey(key));
      if (earlier)
        return skip(
          `row ${earlier} already imports a voice for ${characterId} in ${w.id}`,
        );
      const appearance = appearanceByKey.get(appKey(key));
      const holder = appearance ? voiceByAppearance.get(appearance.id) : null;
      takenAppearance.set(appKey(key), n);
      if (holder) return update(holder);
      return insert(key, `${characterName} (${w.year})`, () => {
        if (!work) {
          const planned = plannedWork.get(w.id);
          if (planned) planned.rows.push(n);
          else {
            const write = {
              kind: "insert_work" as const,
              rows: [n],
              row: {
                id: w.id,
                title: w.title,
                year: w.year,
                medium: w.medium,
                franchise_id: present(w.franchise_id) ? w.franchise_id : null,
              },
            };
            plannedWork.set(w.id, write);
            works.push(write);
          }
        }
        if (!appearance)
          appearanceWrites.push({
            kind: "insert_appearance",
            rows: [n],
            row: {
              ...key,
              voice_actor: isText(m.voice_actor) ? m.voice_actor : null,
            },
          });
      });
    }

    // 3. A designed voice: (character_id, md5) among voices with no appearance.
    const match = input.voices.find(
      (v) =>
        v.character_id === characterId &&
        v.appearance_id === null &&
        v.source_clip_md5 === md5,
    );
    if (match) return update(match);
    const stored = firstStoredDesign([...input.voices], characterId);
    return insert(null, characterName, () => {
      if (stored)
        note(
          `${characterId} also has the stored design row ${voiceName(stored)} (needs_clip); the designed voice is written as a new row beside it`,
        );
    });
  });

  return {
    writes: [...works, ...appearanceWrites, ...voiceWrites],
    skips,
    notes,
  };
}
