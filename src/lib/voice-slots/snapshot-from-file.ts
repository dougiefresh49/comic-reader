import { archiveRefusalsCheap } from "./archive";
import {
  checkClip,
  checkSnapshot,
  clipContentType,
  uploadClip,
} from "./bucket";
import { getVoice, md5Hex } from "./elevenlabs";
import { readVoice, recordSnapshot } from "./registry";
import type {
  SnapshotFromFileResult,
  SourceClipMatch,
  VoiceRow,
  VoiceSlotsDeps,
} from "./types";

/**
 * Stores a clip the owner kept and confirmed as an active voice's source
 * clip (#475). `snapshotSample` cannot do this for a clone: ElevenLabs serves
 * its sample re-encoded, so the hash never matches. Here `confirmedMd5` (the
 * md5 the owner confirmed) is the gate, and the ElevenLabs samples are
 * evidence beside it: a sample whose hash or size matches is reported, and
 * neither "no match" nor a second sample refuses.
 *
 * The row checks run on a fresh read. Without `execute` nothing is written.
 * With it: the clip goes to `<voices.id>/<fileName>` without overwrite, then
 * `recordSnapshot` writes the two columns. No manifest is written;
 * `checkSnapshot` reads a row with none as one clip at `source_clip_path`.
 */
export async function snapshotFromFile(
  deps: VoiceSlotsDeps,
  voice: VoiceRow,
  file: { fileName: string; bytes: Uint8Array },
  confirmedMd5: string,
  opts: { execute?: boolean } = {},
): Promise<SnapshotFromFileResult> {
  const row = await readVoice(deps.supabase, voice.id);
  if (!row) throw new Error(`voice ${voice.id} not found`);

  const { fileName, bytes } = file;
  const md5 = md5Hex(bytes);
  const objectPath = `${row.id}/${fileName}`;

  const flags: string[] = [];
  const el = row.current_elevenlabs_id
    ? await getVoice(deps, row.current_elevenlabs_id)
    : null;
  if (!el) flags.push("no current_elevenlabs_id, so no samples read");
  const samples = (el?.samples ?? []).map((s) => ({
    fileName: s.file_name,
    sizeBytes: s.size_bytes,
    hash: s.hash,
  }));
  if (el && samples.length === 0) flags.push("no sample on ElevenLabs");
  if (samples.length > 1)
    flags.push(
      `${samples.length} samples on ElevenLabs; one clip is stored, so a restore rebuilds the voice from less than it has now`,
    );
  const match: SourceClipMatch = samples.some((s) => s.hash === md5)
    ? "md5 equals the sample hash"
    : samples.some((s) => s.sizeBytes === bytes.byteLength)
      ? "bytes equal the sample size"
      : "no match";

  const refusals: string[] = [];
  if (md5 !== confirmedMd5)
    refusals.push(`file md5 ${md5} differs from --md5 ${confirmedMd5}`);
  if (row.status !== "active") refusals.push(`status is ${row.status}`);
  if (row.source_clip_path || row.source_clip_md5)
    refusals.push(
      `row already holds a source clip (path ${row.source_clip_path ?? "null"}, md5 ${row.source_clip_md5 ?? "null"})`,
    );
  if (fileName.includes("/") || fileName === "snapshot.json")
    refusals.push(`file name cannot be stored safely: ${fileName}`);
  const stored = await checkClip(deps.supabase, objectPath, md5);
  if (stored.status === "mismatch")
    refusals.push(
      `${objectPath} already holds different bytes (md5 ${stored.md5})`,
    );

  const ok = refusals.length === 0;
  const result: SnapshotFromFileResult = {
    voice: row,
    ok,
    refusals,
    flags,
    samples,
    fileName,
    bytes: bytes.byteLength,
    md5,
    match,
    objectPath,
    alreadyStored: stored.status === "ok",
    archiveRefusalsBefore: archiveRefusalsCheap(row),
    executed: false,
  };
  if (!ok || !opts.execute) return result;

  if (!result.alreadyStored)
    await uploadClip(
      deps.supabase,
      objectPath,
      bytes,
      clipContentType(fileName),
    );
  await recordSnapshot(deps.supabase, row.id, objectPath, md5);
  const after = await readVoice(deps.supabase, row.id);
  if (!after) throw new Error(`voice ${row.id} not found after the write`);
  return {
    ...result,
    voice: after,
    executed: true,
    archiveRefusalsAfter: archiveRefusalsCheap(after),
    snapshotStatus: (await checkSnapshot(deps.supabase, after)).status,
  };
}
