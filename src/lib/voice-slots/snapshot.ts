import { checkClip, uploadClip, writeManifest } from "./bucket";
import { downloadSample, getVoice, md5Hex } from "./elevenlabs";
import { recordSnapshot } from "./registry";
import type {
  SnapshotManifest,
  SnapshotResult,
  SnapshotSampleReport,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

/**
 * Copies every sample ElevenLabs holds for the voice into the bucket, the
 * restore source for cloned and generated voices alike (decision 2). Free
 * GETs only; the uploads and the row write need `execute`. Refuses when any
 * sample's md5 differs from the `hash` ElevenLabs reports for it.
 *
 * `voices.source_clip_path` holds one path, so a voice with several samples
 * writes the first there and names every sample in a manifest at
 * `<voices.id>/snapshot.json`, which restore reads. Every sample is archived
 * and every one is hash-checked, so nothing a kid hears is lost to the
 * single-path column.
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

  const samples: SnapshotSampleReport[] = [];
  const pending: { raw: Uint8Array; mimeType: string }[] = [];
  const paths = new Set<string>();
  for (const s of el.samples) {
    const raw = await downloadSample(deps, elId, s.sample_id);
    const md5 = md5Hex(raw);
    const match = md5 === s.hash;
    // ElevenLabs serves cloned voices' samples re-encoded (1762995 bytes
    // for 1325804 uploaded, 2026-09-29), so the sizes are the
    // tell. Generated voices' previews come back byte for byte.
    if (!match)
      refusals.push(
        `md5 mismatch on ${s.file_name} (${raw.byteLength} bytes served, ${s.size_bytes} uploaded)`,
      );
    const objectPath = `${voice.id}/${s.file_name}`;
    if (
      paths.has(objectPath) ||
      s.file_name.includes("/") ||
      s.file_name === "snapshot.json"
    )
      refusals.push(`sample filename cannot be stored safely: ${s.file_name}`);
    paths.add(objectPath);
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
    for (let i = 0; i < samples.length; i++) {
      const report = samples[i]!;
      if (report.alreadyStored) continue;
      await uploadClip(
        deps.supabase,
        report.objectPath,
        pending[i]!.raw,
        pending[i]!.mimeType,
      );
    }
    const manifest: SnapshotManifest = {
      voiceId: voice.id,
      formerElevenLabsId: elId,
      samples: samples.map((s) => ({
        fileName: s.fileName,
        objectPath: s.objectPath,
        md5: s.md5,
        elevenLabsHash: s.elevenLabsHash,
        bytes: s.bytes,
      })),
    };
    await writeManifest(deps.supabase, manifest);
    const first = samples[0]!;
    await recordSnapshot(deps.supabase, voice.id, first.objectPath, first.md5);
  }
  return {
    voice,
    ok,
    refusals,
    samples,
    executed,
    manifestWritten: executed,
  };
}
