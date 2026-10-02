import {
  checkSnapshot,
  clipContentType,
  clipFileName,
  clipObjectPath,
  downloadClip,
} from "./bucket";
import {
  ElevenLabsHeadroomError,
  OP_LABEL,
  addVoice,
  buildAddVoiceForm,
  describeForm,
  md5Hex,
  metadataRefusals,
  type AddVoiceInput,
  type SampleFile,
} from "./elevenlabs";
import { deleteRecorded, markRestored, registerVoice } from "./registry";
import type {
  CreateVoiceMeta,
  CreateVoiceResult,
  RestoreRefusal,
  RestoreResult,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

/**
 * Brings an archived voice back from its hash-checked bucket copy as a
 * cloned IVC, carrying the row's description and labels (voice-lab's
 * standing rules), then writes #66's rows. No local path is read (row 24).
 *
 * Every sample goes into the add when the voice has more than one: a
 * snapshot writes the first to `source_clip_path` and the rest to a manifest
 * beside it, and all of them are hash-checked again here. A row without a
 * description or labels is refused in the plan and
 * before the request: both fields are on every clone, and a request that
 * drops them is the payload defect this issue exists to close.
 */
export async function restoreVoice(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  opts: {
    execute?: boolean;
    /** The caller saw this voice's DELETE succeed (`ArchiveRecordError`). */
    deleteConfirmed?: boolean;
    /** Minted per add; sent as the `OP_LABEL` label so a lost reply can be matched. */
    opToken?: string;
  } = {},
): Promise<RestoreResult> {
  const refusals: RestoreRefusal[] = [];
  // An `active` row whose DELETE is confirmed or recorded is archived in
  // fact: the registry write after the DELETE failed (#351).
  const deleted =
    voice.status === "active" &&
    (opts.deleteConfirmed === true ||
      (await deleteRecorded(deps.supabase, voice)));
  if (voice.status !== "archived" && !deleted) refusals.push("not archived");
  if (!voice.source_clip_path || !voice.source_clip_md5)
    refusals.push("no snapshot");
  const base = { voice, refusals, warnings: [] as string[], executed: false };
  if (refusals.length > 0) return { ...base, ok: false };

  const stored = await checkSnapshot(deps.supabase, voice);
  if (stored.status === "missing") refusals.push("bucket copy missing");
  if (stored.status === "mismatch") refusals.push("md5 mismatch");
  if (stored.status !== "ok") return { ...base, ok: false };

  const warnings: string[] = [];
  if (!voice.description) warnings.push("no description on the row");
  if (!voice.labels || Object.keys(voice.labels).length === 0)
    warnings.push("no labels on the row");
  refusals.push(...metadataRefusals(voice));
  if (refusals.length > 0) return { ...base, ok: false, warnings };
  if (!opts.execute) return { ...base, ok: true, warnings };

  let created: { voice_id: string };
  try {
    created = await addVoice(deps, {
      name: voice.display_name,
      files: stored.files,
      description: voice.description,
      labels: opts.opToken
        ? { ...voice.labels, [OP_LABEL]: opts.opToken }
        : voice.labels,
    });
  } catch (err) {
    if (err instanceof ElevenLabsHeadroomError)
      return {
        ...base,
        ok: false,
        warnings,
        refusals: [...refusals, ...err.refusals],
      };
    throw err;
  }
  await markRestored(deps.supabase, voice, created.voice_id);
  return {
    ...base,
    ok: true,
    warnings,
    executed: true,
    newElevenLabsId: created.voice_id,
  };
}

/**
 * One ElevenLabs add from several bucket clips (lead note 0; #110 case E).
 * `files` are object paths in `comic-voice-clips`. Returns the new id and
 * writes no `voices` row unless `register` is set. Without `execute` it
 * returns the multipart payload it would send, one line per field.
 */
export async function createVoiceFromSamples(
  deps: VoiceSlotsDeps,
  files: string[],
  meta: CreateVoiceMeta,
  opts: { register?: boolean; execute?: boolean } = {},
): Promise<CreateVoiceResult> {
  if (files.length === 0) throw new Error("createVoiceFromSamples: no files");
  const samples: SampleFile[] = [];
  for (const path of files) {
    const objectPath = clipObjectPath(path);
    const bytes = await downloadClip(deps.supabase, objectPath);
    if (!bytes) throw new Error(`bucket copy missing: ${objectPath}`);
    const filename = clipFileName(objectPath);
    samples.push({ filename, mimeType: clipContentType(filename), bytes });
  }
  const input: AddVoiceInput = {
    name: meta.name,
    files: samples,
    description: meta.description ?? null,
    labels: meta.labels ?? null,
  };
  const payload = await describeForm(buildAddVoiceForm(input));
  if (!opts.execute) return { executed: false, payload };

  const refused = metadataRefusals(meta);
  if (refused.length > 0)
    throw new Error(
      `createVoiceFromSamples refused before POST /v1/voices/add: ${refused.join(", ")}`,
    );
  const created = await addVoice(deps, input);
  let registeredId: string | undefined;
  if (opts.register) {
    const only = samples.length === 1 ? samples[0] : undefined;
    registeredId = await registerVoice(deps.supabase, {
      display_name: meta.name,
      current_elevenlabs_id: created.voice_id,
      description: meta.description ?? null,
      labels: meta.labels ?? null,
      source_clip_path: only ? clipObjectPath(files[0]!) : null,
      source_clip_md5: only ? md5Hex(only.bytes) : null,
    });
  }
  return { executed: true, payload, voiceId: created.voice_id, registeredId };
}
