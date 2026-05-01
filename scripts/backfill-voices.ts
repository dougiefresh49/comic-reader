#!/usr/bin/env node

/**
 * One-shot backfill: populate `voices` from existing castlist rows.
 *
 * For each distinct voice_id (the ElevenLabs id stored on castlist),
 * insert one voices row with:
 *   display_name           = character name
 *   current_elevenlabs_id  = the existing EL id (no recreation)
 *   status                 = 'active' (it's actively used today)
 *   keep_active            = false (per fidelity test outcome:
 *                                   recreation is indistinguishable)
 *   source_clip_path       = null (we don't have clips persisted yet;
 *                                  upload to comic-voice-clips later)
 *
 * Then UPDATE castlist.voice_uuid = the new voices.id.
 *
 * Idempotent: skips voice_ids that already have a voices row.
 *
 * Usage:
 *   pnpm backfill-voices              # apply
 *   pnpm backfill-voices -- --dry-run # preview only
 */

import { supabase } from "./lib/supabase.js";

interface Args {
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: pnpm backfill-voices [-- --dry-run]");
    process.exit(0);
  }
  return { dryRun };
}

interface CastlistRow {
  book_id: string;
  issue_id: string;
  character: string;
  voice_id: string | null;
  voice_uuid: string | null;
}

interface VoiceRow {
  id: string;
  current_elevenlabs_id: string | null;
  display_name: string;
}

async function main() {
  const { dryRun } = parseArgs();

  const [castlistRes, voicesRes] = await Promise.all([
    supabase.from("castlist").select("*"),
    supabase.from("voices").select("id, current_elevenlabs_id, display_name"),
  ]);
  if (castlistRes.error) throw new Error(castlistRes.error.message);
  if (voicesRes.error) throw new Error(voicesRes.error.message);

  const castlist = (castlistRes.data ?? []) as CastlistRow[];
  const existingVoices = (voicesRes.data ?? []) as VoiceRow[];
  const existingByElId = new Map<string, VoiceRow>();
  for (const v of existingVoices) {
    if (v.current_elevenlabs_id) existingByElId.set(v.current_elevenlabs_id, v);
  }

  // Group castlist by voice_id, picking the first character name as canonical.
  // (All castlist rows with the same voice_id share the same character in
  // current data, but defensively we'll accept the first.)
  const groups = new Map<string, { character: string; rows: CastlistRow[] }>();
  for (const r of castlist) {
    if (!r.voice_id) continue;
    const existing = groups.get(r.voice_id);
    if (existing) existing.rows.push(r);
    else groups.set(r.voice_id, { character: r.character, rows: [r] });
  }

  console.log(
    `\n📋 Backfill plan: ${groups.size} distinct voice(s) across ${castlist.length} castlist row(s)\n`,
  );

  let toInsert = 0;
  let toLink = 0;
  let alreadyDone = 0;

  const inserts: {
    voice_id: string;
    character: string;
    rows: CastlistRow[];
  }[] = [];

  for (const [voiceId, { character, rows }] of groups) {
    const existing = existingByElId.get(voiceId);
    if (existing) {
      // Voice already in voices; check if castlist rows still need linking.
      const unlinked = rows.filter((r) => r.voice_uuid !== existing.id);
      if (unlinked.length === 0) {
        alreadyDone++;
        continue;
      }
      toLink += unlinked.length;
      console.log(
        `   ↻ ${character} (${voiceId}) — link ${unlinked.length} castlist row(s) to existing voice`,
      );
      continue;
    }
    toInsert++;
    inserts.push({ voice_id: voiceId, character, rows });
    console.log(
      `   + ${character} (${voiceId}) — new voice + link ${rows.length} row(s)`,
    );
  }

  if (alreadyDone > 0) {
    console.log(`   ${alreadyDone} voice(s) already backfilled — skipping.`);
  }

  if (dryRun) {
    console.log(
      `\n   --dry-run: ${toInsert} insert(s) + ${toLink} link-only update(s) skipped.\n`,
    );
    return;
  }

  if (toInsert === 0 && toLink === 0) {
    console.log(`\n✅ Nothing to do.\n`);
    return;
  }

  console.log();
  let insertedCount = 0;
  for (const item of inserts) {
    const { data, error } = await supabase
      .from("voices")
      .insert({
        display_name: item.character,
        status: "active",
        current_elevenlabs_id: item.voice_id,
        keep_active: false,
      })
      .select("id")
      .single();
    if (error || !data)
      throw new Error(`insert voice ${item.character}: ${error?.message}`);
    const voiceUuid = (data as { id: string }).id;

    const link = await supabase
      .from("castlist")
      .update({ voice_uuid: voiceUuid })
      .eq("voice_id", item.voice_id);
    if (link.error)
      throw new Error(
        `link castlist for ${item.character}: ${link.error.message}`,
      );
    insertedCount++;
  }

  // Link-only updates for voices already in `voices` but with stale castlist FKs.
  let linkedOnly = 0;
  for (const [voiceId, { rows }] of groups) {
    const existing = existingByElId.get(voiceId);
    if (!existing) continue;
    const unlinked = rows.filter((r) => r.voice_uuid !== existing.id);
    if (unlinked.length === 0) continue;
    const link = await supabase
      .from("castlist")
      .update({ voice_uuid: existing.id })
      .eq("voice_id", voiceId);
    if (link.error)
      throw new Error(
        `link castlist for ${existing.display_name}: ${link.error.message}`,
      );
    linkedOnly += unlinked.length;
  }

  console.log(
    `\n✅ Inserted ${insertedCount} voice(s); linked ${linkedOnly} additional castlist row(s).`,
  );
  console.log(`   Note: source_clip_path is null on all backfilled voices —`);
  console.log(
    `   --restore will skip them until clips are uploaded to comic-voice-clips.\n`,
  );
}

main().catch((err) => {
  console.error("❌ backfill-voices:", err);
  process.exit(1);
});
