import { checkClip, uploadClip } from "./bucket";
import { downloadSample, getVoice, md5Hex } from "./elevenlabs";
import { recordSnapshot } from "./registry";
import type {
  SnapshotResult,
  SnapshotSampleReport,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

/**
 * Copies the voice's ElevenLabs-stored sample into the bucket, the restore
 * source for cloned and generated voices alike (decision 2). Free GETs
 * only; the upload and the row write need `execute`. Refuses when a sample's
 * md5 differs from the `hash` ElevenLabs reports for it, or when the voice
 * holds more than one sample, since `source_clip_path` holds one path.
 */
export async function snapshotSample(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  opts: { execute?: boolean } = {},
): Promise<SnapshotResult> {
  const elId = voice.current_elevenlabs_id;
  if (!elId)
    return {
      voice,
      ok: false,
      refusals: ["no current_elevenlabs_id"],
      samples: [],
      executed: false,
    };

  const el = await getVoice(deps, elId);
  const refusals: string[] = [];
  if (el.samples.length === 0) refusals.push("no sample on ElevenLabs");
  if (el.samples.length > 1)
    refusals.push(
      `${el.samples.length} samples; source_clip_path holds one, row not written`,
    );

  const samples: SnapshotSampleReport[] = [];
  const pending: { raw: Uint8Array; mimeType: string }[] = [];
  for (const s of el.samples) {
    const raw = await downloadSample(deps, elId, s.sample_id);
    const md5 = md5Hex(raw);
    const match = md5 === s.hash;
    // ElevenLabs serves cloned voices' samples re-encoded (raph.mp3 came back
    // 1762995 bytes for 1325804 uploaded, 2026-09-29), so the sizes are the
    // tell. Generated voices' previews come back byte for byte.
    if (!match)
      refusals.push(
        `md5 mismatch on ${s.file_name} (${raw.byteLength} bytes served, ${s.size_bytes} uploaded)`,
      );
    const objectPath = `${voice.id}/${s.file_name}`;
    const stored = await checkClip(deps.supabase, objectPath, md5);
    if (stored.status === "mismatch")
      refusals.push(
        `${objectPath} already holds different bytes (md5 ${stored.md5})`,
      );
    samples.push({
      sampleId: s.sample_id,
      fileName: s.file_name,
      bytes: raw.byteLength,
      elevenLabsHash: s.hash,
      md5,
      match,
      objectPath,
      alreadyStored: stored.status === "ok",
    });
    pending.push({ raw, mimeType: s.mime_type });
  }

  const ok = refusals.length === 0;
  const executed = Boolean(opts.execute && ok);
  if (executed) {
    const report = samples[0]!;
    const { raw, mimeType } = pending[0]!;
    if (!report.alreadyStored)
      await uploadClip(deps.supabase, report.objectPath, raw, mimeType);
    await recordSnapshot(
      deps.supabase,
      voice.id,
      report.objectPath,
      report.md5,
    );
  }
  return { voice, ok, refusals, samples, executed };
}
