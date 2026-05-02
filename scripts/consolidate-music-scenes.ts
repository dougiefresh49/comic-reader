#!/usr/bin/env node

/**
 * Group panels into music scenes — consecutive panels with the same
 * normalized music_mood get one music_scenes row so the runtime keeps
 * the bed playing instead of restarting every panel.
 *
 * Usage:
 *   pnpm consolidate-music-scenes -- --book <id> --issue <id>
 *   pnpm consolidate-music-scenes -- --all
 *   pnpm consolidate-music-scenes -- --book <id> --issue <id> --dry-run
 */

import { supabase } from "./lib/supabase.js";

interface Args {
  book?: string;
  issue?: string;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Usage:
  pnpm consolidate-music-scenes -- --book <id> --issue <id>
  pnpm consolidate-music-scenes -- --all
  pnpm consolidate-music-scenes -- --all --dry-run
`);
    process.exit(0);
  }
  let book: string | undefined;
  let issue: string | undefined;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--book") book = argv[i + 1]?.trim();
    else if (a.startsWith("--book=")) book = a.split("=")[1]?.trim();
    else if (a === "--issue") issue = argv[i + 1]?.trim();
    else if (a.startsWith("--issue=")) issue = a.split("=")[1]?.trim();
    else if (a === "--all") all = true;
    else if (a === "--dry-run") dryRun = true;
  }
  if (!all && (!book || !issue)) {
    console.error("❌ Provide --book + --issue, or --all.");
    process.exit(1);
  }
  return { book, issue, all, dryRun };
}

interface PanelRow {
  id: string;
  page_number: number;
  sort_order: number;
  audio_tags: { music_mood?: string } | null;
  is_new_scene: boolean;
}

function normalizeMood(mood: string): string {
  return mood.replace(/_[a-z]$/, "").replace(/_\d+$/, "");
}

interface MusicRun {
  mood: string;
  panels: PanelRow[];
}

function groupIntoRuns(panels: PanelRow[]): MusicRun[] {
  const runs: MusicRun[] = [];
  let current: MusicRun | null = null;

  for (const p of panels) {
    const raw = p.audio_tags?.music_mood ?? "transition_neutral";
    const mood = normalizeMood(raw);

    if (current && mood === current.mood && !p.is_new_scene) {
      current.panels.push(p);
    } else {
      if (current) runs.push(current);
      current = { mood, panels: [p] };
    }
  }
  if (current) runs.push(current);
  return runs;
}

async function processIssue(
  bookId: string,
  issueId: string,
  dryRun: boolean,
): Promise<number> {
  const { data: panels, error } = await supabase
    .from("panels")
    .select("id, page_number, sort_order, audio_tags, is_new_scene")
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .order("page_number")
    .order("sort_order");

  if (error) throw new Error(`fetch panels: ${error.message}`);
  if (!panels || panels.length === 0) {
    console.log(`   ${bookId}/${issueId}: no panels, skipping.`);
    return 0;
  }

  const runs = groupIntoRuns(panels as PanelRow[]);

  console.log(
    `   ${bookId}/${issueId}: ${panels.length} panels → ${runs.length} scene(s)`,
  );
  for (const r of runs) {
    const first = r.panels[0]!;
    const last = r.panels[r.panels.length - 1]!;
    console.log(
      `     • "${r.mood}" — ${r.panels.length} panel(s), p${first.page_number}#${first.sort_order}→p${last.page_number}#${last.sort_order}`,
    );
  }

  if (dryRun) return runs.length;

  // Delete existing scenes for this issue (idempotent)
  await supabase
    .from("panels")
    .update({ scene_id: null })
    .eq("book_id", bookId)
    .eq("issue_id", issueId)
    .not("scene_id", "is", null);

  const { error: delErr } = await supabase
    .from("music_scenes")
    .delete()
    .eq("book_id", bookId)
    .eq("issue_id", issueId);
  if (delErr) throw new Error(`delete old scenes: ${delErr.message}`);

  for (const run of runs) {
    const first = run.panels[0]!;
    const last = run.panels[run.panels.length - 1]!;

    const { data: scene, error: insErr } = await supabase
      .from("music_scenes")
      .insert({
        book_id: bookId,
        issue_id: issueId,
        music_mood: run.mood,
        start_panel_id: first.id,
        end_panel_id: last.id,
      })
      .select("id")
      .single();
    if (insErr || !scene)
      throw new Error(`insert scene: ${insErr?.message ?? "no data"}`);

    const sceneId = (scene as { id: string }).id;
    const panelIds = run.panels.map((p) => p.id);

    const { error: updErr } = await supabase
      .from("panels")
      .update({ scene_id: sceneId })
      .in("id", panelIds);
    if (updErr) throw new Error(`update panels.scene_id: ${updErr.message}`);
  }

  return runs.length;
}

async function main() {
  const { book, issue, all, dryRun } = parseArgs();

  console.log(`\n🎵 Consolidate music scenes${dryRun ? " (dry run)" : ""}\n`);

  let issues: Array<{ book_id: string; issue_id: string }>;

  if (all) {
    const { data, error } = await supabase
      .from("panels")
      .select("book_id, issue_id")
      .limit(1000);
    if (error) throw new Error(`fetch issues: ${error.message}`);
    const seen = new Set<string>();
    issues = [];
    for (const r of data ?? []) {
      const key = `${r.book_id}/${r.issue_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push({ book_id: r.book_id, issue_id: r.issue_id });
      }
    }
    issues.sort((a, b) =>
      `${a.book_id}/${a.issue_id}`.localeCompare(`${b.book_id}/${b.issue_id}`),
    );
  } else {
    issues = [{ book_id: book!, issue_id: issue! }];
  }

  let totalScenes = 0;
  for (const iss of issues) {
    totalScenes += await processIssue(iss.book_id, iss.issue_id, dryRun);
  }

  console.log(
    `\n✅ ${totalScenes} scene(s) across ${issues.length} issue(s)${dryRun ? " (dry run — nothing written)" : ""}.\n`,
  );
}

main().catch((err) => {
  console.error("❌ consolidate-music-scenes:", err);
  process.exit(1);
});
