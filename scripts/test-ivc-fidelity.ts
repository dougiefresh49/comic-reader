#!/usr/bin/env node

/**
 * IVC fidelity test — does deleting + recreating an ElevenLabs IVC
 * from its source samples produce a voice that sounds the same?
 *
 * Per specs/roadmap/04-voice-rotation.md, the whole archive/restore
 * plan rests on this assumption. This script runs the test recipe
 * end-to-end against a safe-to-break voice.
 *
 * Steps:
 *   1. Pull voice metadata + settings (saved to ./tmp/ivc-fidelity-test/)
 *   2. Generate "before" reference line with the original
 *   3. Pull source samples + download each sample audio
 *   4. DELETE the IVC
 *   5. POST samples back as a NEW IVC with the same name
 *   6. Generate "after" line with the recreated IVC
 *
 * Outputs both audio files for side-by-side listening. The user judges.
 *
 * Default voice: kaQG4rvOTzT2F2yIXtSN (random generic soldier — user
 * has flagged this as safe to break).
 *
 * Usage:
 *   pnpm test-ivc-fidelity                            # uses default voice
 *   pnpm test-ivc-fidelity -- --voice <id>            # custom voice
 *   pnpm test-ivc-fidelity -- --voice <id> --keep     # don't actually delete
 */

import fs from "fs-extra";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const DEFAULT_VOICE_ID = "kaQG4rvOTzT2F2yIXtSN";
const REFERENCE_LINE = "Halt! Identify yourself or face the consequences.";
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };

interface Args {
  voiceId: string;
  keep: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage: pnpm test-ivc-fidelity [-- --voice <id>] [--keep]

Options:
  --voice <id>   ElevenLabs voice id to test (default ${DEFAULT_VOICE_ID})
  --keep         Skip the DELETE step. Only generates "before" — useful
                 for sanity-checking the pull/generate path without risk.
`);
    process.exit(0);
  }
  let voiceId = DEFAULT_VOICE_ID;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--voice") voiceId = argv[i + 1]?.trim() ?? voiceId;
    else if (a.startsWith("--voice="))
      voiceId = a.split("=")[1]?.trim() ?? voiceId;
    else if (a === "--keep") keep = true;
  }
  return { voiceId, keep };
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("❌ ELEVENLABS_API_KEY not set.");
  process.exit(1);
}

async function el(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: {
      "xi-api-key": apiKey!,
      ...(init?.headers ?? {}),
    },
  });
}

async function getVoice(voiceId: string): Promise<unknown> {
  const r = await el(`/v1/voices/${voiceId}`);
  if (!r.ok) throw new Error(`GET /v1/voices/${voiceId} → ${r.status}`);
  return r.json();
}

async function tts(voiceId: string, text: string): Promise<ArrayBuffer> {
  const r = await el(`/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_settings: VOICE_SETTINGS }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(
      `POST /v1/text-to-speech/${voiceId} → ${r.status}: ${t.slice(0, 200)}`,
    );
  }
  return r.arrayBuffer();
}

interface Sample {
  sample_id: string;
  file_name: string;
  mime_type: string;
}

async function listSamples(voiceId: string): Promise<Sample[]> {
  // ElevenLabs returns samples on the voice payload; fetch with samples=true.
  const r = await el(`/v1/voices/${voiceId}?with_settings=true`);
  if (!r.ok) throw new Error(`samples list → ${r.status}`);
  const body = (await r.json()) as { samples?: Sample[] };
  return body.samples ?? [];
}

async function downloadSample(
  voiceId: string,
  sampleId: string,
): Promise<ArrayBuffer> {
  const r = await el(`/v1/voices/${voiceId}/samples/${sampleId}/audio`);
  if (!r.ok) throw new Error(`sample audio → ${r.status}`);
  return r.arrayBuffer();
}

async function deleteVoice(voiceId: string): Promise<void> {
  const r = await el(`/v1/voices/${voiceId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE /v1/voices/${voiceId} → ${r.status}`);
}

interface CreateIVCResult {
  voice_id: string;
}

async function recreateIVC(
  name: string,
  samples: { filename: string; bytes: ArrayBuffer; mimeType: string }[],
): Promise<CreateIVCResult> {
  const form = new FormData();
  form.append("name", name);
  for (const s of samples) {
    form.append("files", new Blob([s.bytes], { type: s.mimeType }), s.filename);
  }
  const r = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": apiKey! },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST /v1/voices/add → ${r.status}: ${t.slice(0, 200)}`);
  }
  return (await r.json()) as CreateIVCResult;
}

async function main() {
  const { voiceId, keep } = parseArgs();
  const OUT_DIR = join(PROJECT_ROOT, "tmp", "ivc-fidelity-test");
  await fs.ensureDir(OUT_DIR);

  console.log(`\n🎤 IVC fidelity test for voice ${voiceId}`);
  console.log(`   Output dir: ${OUT_DIR}\n`);

  // 1. Pull metadata
  console.log("1️⃣  Fetching voice metadata...");
  const before = await getVoice(voiceId);
  await fs.writeJSON(join(OUT_DIR, "voice-before.json"), before, { spaces: 2 });

  // 2. Generate "before" reference line
  console.log("2️⃣  Generating reference line with original voice...");
  const beforeMp3 = await tts(voiceId, REFERENCE_LINE);
  const beforePath = join(OUT_DIR, "before.mp3");
  await fs.writeFile(beforePath, Buffer.from(beforeMp3));
  console.log(`   → ${beforePath}`);

  if (keep) {
    console.log(
      "\n--keep set; skipping DELETE + recreate. Listen to before.mp3.",
    );
    return;
  }

  // 3. Pull source samples
  console.log("3️⃣  Listing source samples...");
  const samples = await listSamples(voiceId);
  console.log(`   ${samples.length} sample(s)`);
  if (samples.length === 0) {
    console.error(
      "❌ No samples found on this voice — can't recreate from clips. Aborting.",
    );
    process.exit(1);
  }

  console.log("   Downloading sample audio...");
  const downloaded: {
    filename: string;
    bytes: ArrayBuffer;
    mimeType: string;
  }[] = [];
  for (const s of samples) {
    const bytes = await downloadSample(voiceId, s.sample_id);
    const safeName = s.file_name || `${s.sample_id}.mp3`;
    await fs.writeFile(join(OUT_DIR, `sample-${safeName}`), Buffer.from(bytes));
    downloaded.push({
      filename: safeName,
      bytes,
      mimeType: s.mime_type || "audio/mpeg",
    });
    console.log(`   ✓ ${safeName} (${(bytes.byteLength / 1024).toFixed(0)}KB)`);
  }

  // Capture original name for recreation
  type VoiceMeta = { name?: string };
  const meta = before as VoiceMeta;
  const originalName = meta.name ?? `Voice ${voiceId}`;
  const recreatedName = `${originalName} (recreated)`;

  // 4. DELETE
  console.log("4️⃣  Deleting original IVC...");
  await deleteVoice(voiceId);
  console.log(`   ✓ ${voiceId} deleted`);

  // 5. Recreate from samples
  console.log("5️⃣  Recreating IVC from saved samples...");
  const created = await recreateIVC(recreatedName, downloaded);
  console.log(`   ✓ new voice id: ${created.voice_id}`);

  await fs.writeJSON(
    join(OUT_DIR, "recreated-voice.json"),
    { original_voice_id: voiceId, recreated: created },
    { spaces: 2 },
  );

  // 6. Generate "after" line
  console.log("6️⃣  Generating reference line with recreated voice...");
  const afterMp3 = await tts(created.voice_id, REFERENCE_LINE);
  const afterPath = join(OUT_DIR, "after.mp3");
  await fs.writeFile(afterPath, Buffer.from(afterMp3));
  console.log(`   → ${afterPath}`);

  console.log(`\n✅ Done. Listen to:`);
  console.log(`   ${beforePath}`);
  console.log(`   ${afterPath}`);
  console.log(`\n   Recreated voice id: ${created.voice_id}`);
  console.log(
    `   You can DELETE this through the EL UI when finished comparing.\n`,
  );
}

main().catch((err) => {
  console.error("❌ test-ivc-fidelity:", err);
  process.exit(1);
});
