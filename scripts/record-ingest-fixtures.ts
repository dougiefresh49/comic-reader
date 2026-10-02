/**
 * Record the DRY_RUN ingest fixtures (#86) from production rows. SELECT-only:
 * no live Gemini, Roboflow or ElevenLabs call, no write to Supabase.
 * Source is tmnt-mmpr-iii issue-1 pages 7-8, stored as fixture pages 1-2.
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/record-ingest-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  INGEST_FIXTURE_PATH,
  type FixtureBox,
  type FixturePage,
  type IngestFixture,
} from "~/lib/fakes/dry-run";
import { rdpSimplify } from "~/workflows/steps/shared";
import { supabase } from "./lib/supabase";

const BOOK_ID = "tmnt-mmpr-iii";
const ISSUE_ID = "issue-1";
const SOURCE_PAGES = [7, 8];
/** Polygon simplification tolerance in pixels, to keep the fixture small. */
const RDP_EPSILON = 3;

type BB = { x: number; y: number; w: number; h: number };
type Box2d = { x?: number; y?: number; width?: number; height?: number };
type Seg = { points?: Array<{ x: number; y: number }> } & Record<
  string,
  unknown
>;

function must<T>(res: { data: T | null; error: { message: string } | null }) {
  if (res.error) throw new Error(res.error.message);
  return res.data!;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const slug = (s: string) => s.toLowerCase().trim().replace(/\s+/g, "-");

/**
 * Production character id (slug) -> made-up fixture id (#186, decision row
 * 77). A DRY_RUN run must never resolve a speaker or face to a global
 * `characters` row, so every made-up id matches no `characters.id` or alias
 * under `fuzzyNameMatch` (substring either way). Recheck against a SELECT of
 * `characters` when adding one. `trini` is `yellow-ranger`'s alias, so both
 * map to one id. `narrator` stays as is.
 *
 * Every id starts with `smoke-` so the smoke run's cleanup of the
 * `characters` rows it creates has a safe filter (#92 decision 0, #196).
 * `fuzzyNameMatch` also treats two multi-word names that share their first
 * and last word as a match, and every id shares `smoke`, so each id has a
 * last word no other id (or `smoke-stranger`) uses.
 */
const FIXTURE_IDS: Record<string, string> = {
  raphael: "smoke-tessik",
  leonardo: "smoke-marwen",
  donatello: "smoke-fenwick",
  michelangelo: "smoke-pollux",
  warbunny: "smoke-hopscald",
  karai: "smoke-vessa",
  "alpha-5": "smoke-gizmo9",
  "red-ranger": "smoke-crimsonvole",
  "pink-ranger": "smoke-rosevole",
  "green-ranger": "smoke-mossvole",
  "yellow-ranger": "smoke-ambervole",
  trini: "smoke-ambervole",
  "foot-soldier": "smoke-drabgrunt",
  "foot-elite": "smoke-drabcaptain",
  "putty-foot-soldier": "smoke-claygrunt",
};

/** Throws on an unmapped name so a re-record cannot write a production id. */
function fixtureId(name: string): string {
  const key = slug(name);
  if (key === "narrator") return key;
  const id = Object.hasOwn(FIXTURE_IDS, key) ? FIXTURE_IDS[key] : undefined;
  if (!id) throw new Error(`no made-up fixture id for "${name}"`);
  return id;
}

async function recordPage(page: number, idx: number): Promise<FixturePage> {
  const scope = (table: string) =>
    supabase
      .from(table)
      .select("*")
      .eq("book_id", BOOK_ID)
      .eq("issue_id", ISSUE_ID);

  const pageRow = must(await scope("pages").eq("number", page).single()) as {
    width: number;
    height: number;
  };
  const seg = must(
    await scope("page_segmentation").eq("page_number", page).single(),
  ) as { predictions: Seg[] };
  const panels = must(
    await scope("panels").eq("page_number", page).order("sort_order"),
  ) as Array<{ id: string; bounding_box: BB }>;
  const bubbles = must(
    await scope("bubbles").eq("page_number", page).order("sort_order"),
  ) as Array<Record<string, unknown> & { box_2d: Box2d | null }>;
  const detections = must(
    await supabase
      .from("panel_character_detections")
      .select("character_id, suggested_name, identification_confidence")
      .in(
        "panel_id",
        panels.map((p) => p.id),
      )
      .order("created_at"),
  ) as Array<{
    character_id: string | null;
    suggested_name: string | null;
    identification_confidence: number;
  }>;

  const { width: W, height: H } = pageRow;
  const panelPredictions: FixtureBox[] = panels.map(({ bounding_box: b }) => ({
    x: r1((b.x + b.w / 2) * W),
    y: r1((b.y + b.h / 2) * H),
    width: r1(b.w * W),
    height: r1(b.h * H),
    confidence: 1,
  }));

  // Bubbles added by hand in review have no geometry; give them a box in
  // their panel (or the page) so the counts match the DB. Placeholders in one
  // panel sit side by side on its middle row, apart, so the ingest's
  // duplicate-bubble filter (#311) keeps every one.
  const hasBox = (b: { box_2d: Box2d | null }) =>
    Boolean(b.box_2d?.width && b.box_2d.height);
  const panelOf = (b: Record<string, unknown>) =>
    panels.find((p) => p.id === b.panel_id);
  const bubblePredictions: FixtureBox[] = bubbles.map((b) => {
    const box = b.box_2d ?? {};
    if (box.width && box.height) {
      return {
        x: r1((box.x ?? 0) + box.width / 2),
        y: r1((box.y ?? 0) + box.height / 2),
        width: r1(box.width),
        height: r1(box.height),
        confidence: 1,
      };
    }
    const panel = panelOf(b);
    const bb = panel?.bounding_box ?? { x: 0, y: 0, w: 1, h: 1 };
    const group = bubbles.filter((o) => !hasBox(o) && panelOf(o) === panel);
    const n = group.length;
    const k = group.indexOf(b);
    return {
      x: r1((bb.x + (bb.w * (k + 1)) / (n + 1)) * W),
      y: r1((bb.y + bb.h / 2) * H),
      width: r1(bb.w * W * Math.min(0.2, 0.8 / (n + 1))),
      height: r1(bb.h * H * 0.2),
      confidence: 1,
    };
  });

  const segmentationPredictions = seg.predictions.map((p) => ({
    ...p,
    points: rdpSimplify(p.points ?? [], RDP_EPSILON).map((pt) => ({
      x: Math.round(pt.x),
      y: Math.round(pt.y),
    })),
  }));

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    fixturePage: idx + 1,
    width: W,
    height: H,
    panelPredictions,
    bubblePredictions,
    segmentationPredictions,
    bubbles: bubbles.map((b) => ({
      legacyId: `page-${String(idx + 1).padStart(2, "0")}_b${String(Number(b.sort_order) + 1).padStart(2, "0")}`,
      sortOrder: Number(b.sort_order),
      ocrText: str(b.ocr_text) ?? "",
      type: str(b.type) ?? "SPEECH",
      speaker: str(b.speaker),
      emotion: str(b.emotion),
      side: str(b.side),
      characterType: str(b.character_type),
      voiceDescription: str(b.voice_description),
      textWithCues: str(b.text_with_cues),
    })),
    faces: detections.flatMap((d) => {
      const name = d.character_id ?? d.suggested_name;
      return name
        ? [{ characterName: name, confidence: d.identification_confidence }]
        : [];
    }),
  };
}

async function main() {
  const pages: FixturePage[] = [];
  for (const [idx, page] of SOURCE_PAGES.entries()) {
    pages.push(await recordPage(page, idx));
  }

  const speakers = [
    ...new Set(
      pages.flatMap((p) =>
        p.bubbles.flatMap((b) => (b.speaker ? [slug(b.speaker)] : [])),
      ),
    ),
  ].sort();
  const appearances = must(
    await supabase
      .from("character_appearances")
      .select("id, character_id, voice_description")
      .in("character_id", speakers)
      .not("voice_description", "is", null)
      .order("id"),
  ) as Array<{ id: string; character_id: string; voice_description: string }>;

  const voiceDescriptions: Record<string, string> = {};
  for (const a of appearances) {
    const key = fixtureId(a.character_id);
    const preferred = a.id === `${a.character_id}-voice-design`;
    if (preferred || !voiceDescriptions[key]) {
      voiceDescriptions[key] = a.voice_description;
    }
  }

  const fixture: IngestFixture = {
    pages: pages.map((p) => ({
      ...p,
      bubbles: p.bubbles.map((b) => ({
        ...b,
        speaker: b.speaker && fixtureId(b.speaker),
      })),
      faces: p.faces.map((f) => ({
        ...f,
        characterName: fixtureId(f.characterName),
      })),
    })),
    voiceDescriptions,
  };
  const out = join(process.cwd(), INGEST_FIXTURE_PATH);
  mkdirSync(dirname(out), { recursive: true });
  // One polygon point per line would triple the file; keep points inline.
  const json = JSON.stringify(fixture, null, 1).replace(
    /\{\s*"x": (-?[\d.]+),\s*"y": (-?[\d.]+)\s*\}/g,
    '{"x":$1,"y":$2}',
  );
  writeFileSync(out, `${json}\n`);

  for (const p of pages) {
    console.log(
      `fixture p${p.fixturePage}: panels=${p.panelPredictions.length} bubbles=${p.bubblePredictions.length} segments=${p.segmentationPredictions.length} faces=${p.faces.length}`,
    );
  }
  console.log(
    `speakers=${speakers.length} voiceDescriptions=${Object.keys(voiceDescriptions).length}`,
  );
  console.log(`wrote ${INGEST_FIXTURE_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
