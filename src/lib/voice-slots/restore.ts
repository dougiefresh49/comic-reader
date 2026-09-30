import {
  checkClip,
  clipContentType,
  clipFileName,
  clipObjectPath,
  downloadClip,
} from "./bucket";
import {
  addVoice,
  buildAddVoiceForm,
  describeForm,
  md5Hex,
  type AddVoiceInput,
  type SampleFile,
} from "./elevenlabs";
import { markRestored, registerVoice } from "./registry";
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
 * A row without a description or labels restores with a warning: the 59
 * import candidates have neither, and the fields change nothing a kid hears.
 */
export async function restoreVoice(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  opts: { execute?: boolean } = {},
): Promise<RestoreResult> {
  const refusals: RestoreRefusal[] = [];
  if (voice.status !== "archived") refusals.push("not archived");
  if (!voice.source_clip_path || !voice.source_clip_md5)
    refusals.push("no snapshot");
  const base = { voice, refusals, warnings: [] as string[], executed: false };
  if (refusals.length > 0) return { ...base, ok: false };

  const objectPath = clipObjectPath(voice.source_clip_path!);
  const stored = await checkClip(
    deps.supabase,
    objectPath,
    voice.source_clip_md5!,
  );
  if (stored.status === "missing") refusals.push("bucket copy missing");
  if (stored.status === "mismatch") refusals.push("md5 mismatch");
  if (stored.status !== "ok") return { ...base, ok: false };

  const warnings: string[] = [];
  if (!voice.description) warnings.push("no description on the row");
  if (!voice.labels || Object.keys(voice.labels).length === 0)
    warnings.push("no labels on the row");
  if (!opts.execute) return { ...base, ok: true, warnings };

  const fileName = clipFileName(objectPath);
  const created = await addVoice(deps, {
    name: voice.display_name,
    files: [
      {
        filename: fileName,
        mimeType: clipContentType(fileName),
        bytes: stored.bytes,
      },
    ],
    description: voice.description,
    labels: voice.labels,
  });
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
