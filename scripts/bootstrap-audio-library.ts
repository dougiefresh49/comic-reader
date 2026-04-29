#!/usr/bin/env node
/**
 * Bootstrap the global audio library by sourcing CC0/Attribution clips
 * from Freesound for every ambience + sfx tag in the enum, and writing
 * them to `comic-audio/library/<layer>/<tag>.mp3` in Supabase.
 *
 * Music moods skip Freesound by default (search quality is poor for
 * mood-based music) and are flagged for ElevenLabs Music gen later.
 *
 * Auth: token-based — uses the API key (FREESOUND_API_KEY). The proper
 * download endpoint requires OAuth2, but every search result includes
 * `previews.preview-hq-mp3` (~128kbps) that's accessible with just the
 * token. That's plenty for ambient/SFX background tracks.
 *
 * Usage:
 *   pnpm bootstrap-audio-library                    # all missing tags
 *   pnpm bootstrap-audio-library -- --tag sword_clang   # one tag
 *   pnpm bootstrap-audio-library -- --layer sfx     # all sfx tags
 *   pnpm bootstrap-audio-library -- --force         # re-download even if exists
 *   pnpm bootstrap-audio-library -- --dry-run       # search only, no downloads
 */

import { createClient } from "@supabase/supabase-js";
import {
  AMBIENCE_TAGS,
  MUSIC_MOODS,
  SFX_TAGS,
  type AmbienceTag,
  type MusicMood,
  type SfxTag,
} from "~/lib/panel-tags.js";

// ── Args ──────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TAG = arg("tag");
const ONLY_LAYER = arg("layer") as "ambience" | "sfx" | "music" | undefined;
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_MUSIC = process.argv.includes("--include-music");

// ── Env ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const FS_API_KEY = process.env.FREESOUND_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}
if (!FS_API_KEY) {
  console.error("Missing FREESOUND_API_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Tag → Freesound query map ─────────────────────────────────────────────
//
// The query fragments lean on Freesound's tag system. Duration ranges
// (`duration:[a TO b]`) cull obvious wrong-fit clips — e.g. SFX should
// be < 4s, ambience loops 8–30s, music 20–60s.

interface TagSpec {
  layer: "ambience" | "sfx" | "music";
  query: string;
  durationFilter: string;
}

const AMBIENCE_QUERIES: Record<AmbienceTag, string> = {
  wind_desert: "desert wind ambience tag:wind tag:desert",
  wind_arctic: "arctic wind cold ambience",
  city_traffic_distant: "distant city traffic ambience tag:traffic",
  rain_steady: "steady rain loop tag:rain",
  energy_hum_low: "low electrical hum drone",
  industrial_machinery: "factory industrial machinery loop",
  forest_birds: "forest birds ambience",
  lab_electronics_beep: "computer lab electronics beep ambience",
  ocean_waves: "ocean waves shore tag:ocean",
};

const SFX_QUERIES: Record<SfxTag, string> = {
  whoosh_metallic_swirl: "metallic whoosh swirl",
  explosion_distant_muffled: "distant muffled explosion",
  explosion_close_punchy: "close punchy explosion impact",
  sword_clang: "sword clang metal hit",
  punch_impact: "punch impact body hit",
  footstep_concrete: "footstep concrete single",
  glass_shatter: "glass shatter break",
  energy_zap: "energy zap electric short",
  thunder_distant: "distant thunder rumble",
  vehicle_engine_rev: "engine rev car short",
};

const MUSIC_QUERIES: Record<MusicMood, string> = {
  tense_climax: "tense climax cinematic music",
  action_chase: "action chase music short",
  somber_reflective: "somber reflective ambient music",
  heroic_triumphant: "heroic triumphant orchestral short",
  menacing_villain: "menacing dark villain music",
  comedic_light: "light comedic music",
  mystery_ambient: "mystery ambient suspense",
  transition_neutral: "neutral cinematic transition pad",
};

const SPECS: TagSpec[] = [
  ...AMBIENCE_TAGS.map<TagSpec>((t) => ({
    layer: "ambience",
    query: AMBIENCE_QUERIES[t],
    durationFilter: "duration:[8 TO 30]",
  })).map(
    (s, i) => ({ ...s, _tag: AMBIENCE_TAGS[i] }) as TagSpec & { _tag: string },
  ),
  ...SFX_TAGS.map<TagSpec>((t) => ({
    layer: "sfx",
    query: SFX_QUERIES[t],
    durationFilter: "duration:[0.2 TO 4]",
  })).map(
    (s, i) => ({ ...s, _tag: SFX_TAGS[i] }) as TagSpec & { _tag: string },
  ),
  ...MUSIC_MOODS.map<TagSpec>((t) => ({
    layer: "music",
    query: MUSIC_QUERIES[t],
    durationFilter: "duration:[20 TO 60]",
  })).map(
    (s, i) => ({ ...s, _tag: MUSIC_MOODS[i] }) as TagSpec & { _tag: string },
  ),
] as Array<TagSpec & { _tag: string }>;

// ── Freesound search ──────────────────────────────────────────────────────

interface FreesoundResult {
  id: number;
  name: string;
  duration: number;
  username: string;
  license: string;
  previews: {
    "preview-hq-mp3": string;
    "preview-lq-mp3": string;
  };
}

interface SearchResponse {
  count: number;
  results: FreesoundResult[];
}

async function freesoundSearch(
  query: string,
  durationFilter: string,
): Promise<FreesoundResult[]> {
  // Prefer CC0 (Creative Commons 0); fall back to Attribution.
  const params = new URLSearchParams({
    query,
    filter: `${durationFilter} (license:"Creative Commons 0" OR license:"Attribution")`,
    fields: "id,name,duration,username,license,previews",
    page_size: "8",
    sort: "rating_desc",
    token: FS_API_KEY!,
  });
  const url = `https://freesound.org/apiv2/search/text/?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  freesound ${res.status}: ${await res.text()}`);
    return [];
  }
  const json = (await res.json()) as SearchResponse;
  return json.results;
}

function pickBest(
  results: FreesoundResult[],
  preferredDuration: number,
): FreesoundResult | null {
  if (results.length === 0) return null;
  // Score by closeness to preferred duration; CC0 wins ties.
  const scored = results.map((r) => ({
    r,
    score:
      Math.abs(r.duration - preferredDuration) +
      (r.license === "Creative Commons 0" ? 0 : 0.5),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.r ?? null;
}

// ── Storage ───────────────────────────────────────────────────────────────

async function storagePathExists(path: string): Promise<boolean> {
  const dir = path.split("/").slice(0, -1).join("/");
  const file = path.split("/").pop()!;
  const { data } = await supabase.storage
    .from("comic-audio")
    .list(dir, { search: file, limit: 1 });
  return !!data?.find((x) => x.name === file);
}

async function downloadAndUpload(
  url: string,
  storagePath: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { error } = await supabase.storage
    .from("comic-audio")
    .upload(storagePath, buf, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (error) throw new Error(`upload ${storagePath}: ${error.message}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

interface BootstrapEntry {
  layer: "ambience" | "sfx" | "music";
  tag: string;
  status: "fetched" | "skipped" | "missed" | "failed" | "deferred";
  source?: { id: number; name: string; license: string; username: string };
  error?: string;
}

async function main() {
  const credits: BootstrapEntry[] = [];
  const targetSpecs = (SPECS as Array<TagSpec & { _tag: string }>).filter(
    (s) => {
      if (ONLY_TAG && s._tag !== ONLY_TAG) return false;
      if (ONLY_LAYER && s.layer !== ONLY_LAYER) return false;
      if (s.layer === "music" && !ONLY_TAG && !ONLY_LAYER && !INCLUDE_MUSIC)
        return false; // music skipped by default
      return true;
    },
  );

  console.log(`Bootstrap target: ${targetSpecs.length} tags`);

  for (const spec of targetSpecs) {
    const path = `library/${spec.layer}/${spec._tag}.mp3`;
    if (!FORCE && (await storagePathExists(path))) {
      console.log(`✓ skip   ${path} (already in bucket)`);
      credits.push({ layer: spec.layer, tag: spec._tag, status: "skipped" });
      continue;
    }

    if (spec.layer === "music" && !INCLUDE_MUSIC && !ONLY_TAG) {
      console.log(`⊘ defer  ${path} (use --include-music)`);
      credits.push({ layer: spec.layer, tag: spec._tag, status: "deferred" });
      continue;
    }

    console.log(`→ search ${path}: "${spec.query}"`);
    const results = await freesoundSearch(spec.query, spec.durationFilter);
    const preferred =
      spec.layer === "sfx" ? 1.5 : spec.layer === "ambience" ? 16 : 30;
    const best = pickBest(results, preferred);
    if (!best) {
      console.log(`  ✗ no results`);
      credits.push({ layer: spec.layer, tag: spec._tag, status: "missed" });
      continue;
    }

    console.log(
      `  · #${best.id} "${best.name}" by ${best.username} (${best.license}, ${best.duration.toFixed(1)}s)`,
    );

    if (DRY_RUN) {
      credits.push({
        layer: spec.layer,
        tag: spec._tag,
        status: "fetched",
        source: {
          id: best.id,
          name: best.name,
          license: best.license,
          username: best.username,
        },
      });
      continue;
    }

    try {
      await downloadAndUpload(best.previews["preview-hq-mp3"], path);
      console.log(`  ✓ uploaded ${path}`);
      credits.push({
        layer: spec.layer,
        tag: spec._tag,
        status: "fetched",
        source: {
          id: best.id,
          name: best.name,
          license: best.license,
          username: best.username,
        },
      });
    } catch (e) {
      console.log(`  ✗ ${(e as Error).message}`);
      credits.push({
        layer: spec.layer,
        tag: spec._tag,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  // ── Write CREDITS.md so attribution licenses are tracked ────────────────
  const attrEntries = credits.filter(
    (c) => c.source && c.source.license !== "Creative Commons 0",
  );
  if (attrEntries.length > 0 && !DRY_RUN) {
    const lines: string[] = [
      "# Audio Library Credits",
      "",
      "Sounds attributed below are licensed CC-BY (Creative Commons Attribution).",
      "CC0-licensed sources do not require attribution and are omitted.",
      "",
    ];
    for (const c of attrEntries) {
      const s = c.source!;
      lines.push(
        `- **${c.layer}/${c.tag}** — "${s.name}" by ${s.username} ([${s.license}], freesound.org/s/${s.id})`,
      );
    }
    const buf = Buffer.from(lines.join("\n"));
    await supabase.storage
      .from("comic-audio")
      .upload("library/CREDITS.md", buf, {
        contentType: "text/markdown",
        upsert: true,
      });
    console.log(
      `\n✓ wrote library/CREDITS.md with ${attrEntries.length} attributions`,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const tally = credits.reduce<Record<string, number>>((m, c) => {
    m[c.status] = (m[c.status] ?? 0) + 1;
    return m;
  }, {});
  console.log("\nSummary:", tally);
  const missed = credits.filter((c) => c.status === "missed");
  if (missed.length > 0) {
    console.log("\nMissing tags (re-run with a more specific --tag):");
    for (const m of missed) console.log(`  - ${m.layer}/${m.tag}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
