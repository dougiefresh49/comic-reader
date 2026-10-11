/**
 * #845 dry run: lookahead's per-panel naming call on a real issue, with no DB
 * write. It runs the step's own crop, embedding and naming code
 * (`loadLookaheadPageOrFatal`, `identifyLookaheadFacesOrFatal`) and prints,
 * per face, the name the stored `panel_character_detections` row has (before)
 * next to the name the new code gives it (after), then the named cast per page
 * and for the issue, and what the run cost. The only writes are the
 * `llm_calls` rows the Gemini wrapper logs, under step `dry-run-lookahead-845`.
 *
 * Paid: one embedding per crop, and one Gemini naming call per panel chunk of
 * up to 12 crops, plus a per-face call for any crop a panel reply leaves out.
 *   pnpm exec tsx --env-file=.env scripts/dry-run-lookahead-calls.ts --count-only
 *   LIVE_API_OK=1 pnpm exec tsx --env-file=.env scripts/dry-run-lookahead-calls.ts
 * Flags: --book (default tmnt-mmpr-iii), --issue (default issue-3),
 * --pages 3,8 (default every page of the issue), --count-only.
 *
 * Comic Vine (#851): when `issues.comicvine_characters` is null and the book
 * has a `comicvine_volume_id` (or `--volume <id>` gives one), the cast is
 * fetched from Comic Vine in memory and used; nothing is written to `issues`.
 * `--cast-only` (free, no Gemini call) prints the name list and looks hint the
 * lookahead would build for the issue and stops; with `--volume` it reads
 * neither new column, so it runs before the #851 migration is applied.
 */
import sharp from "sharp";
import * as characterIdentification from "~/lib/character-identification";
import {
  type ComicVineCharacter,
  fetchComicVineCast,
  parseComicVineCharacters,
} from "~/lib/comicvine";
import * as exemplarStore from "~/lib/exemplar-store";
import * as faceExtraction from "~/lib/face-extraction";
import * as geminiClient from "~/lib/gemini-client";
import * as llmUsage from "~/lib/llm-usage";
import { selectIssue } from "~/lib/issue-queries";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  buildKnownCharacterListOrFatal,
  buildLookaheadCast,
  identifyLookaheadFacesOrFatal,
  loadLookaheadPageOrFatal,
  type LookaheadWikiAppearance,
  type IdentifiedFace,
  type LookaheadDeps,
  type LookaheadPage,
} from "~/workflows/steps/vision";

const deps: LookaheadDeps = {
  imageLib: sharp,
  faceExtraction,
  characterIdentification,
  exemplarStore,
  llmUsage,
  geminiClient,
};

const STEP = "dry-run-lookahead-845";
/** Planned naming calls (one per panel chunk) above which a paid run refuses. */
const MAX_NAMING_CALLS = 120;
/** Mirrors PANEL_FACE_BATCH_MAX in `identifyLookaheadFacesOrFatal`. */
const PANEL_FACE_BATCH_MAX = 12;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const BOOK_ID = arg("book") ?? "tmnt-mmpr-iii";
const ISSUE_ID = arg("issue") ?? "issue-3";
const COUNT_ONLY = process.argv.includes("--count-only");
const CAST_ONLY = process.argv.includes("--cast-only");
const volumeArg = arg("volume");
const VOLUME = volumeArg === undefined ? undefined : Number(volumeArg);
if (VOLUME !== undefined && !(Number.isInteger(VOLUME) && VOLUME > 0)) {
  console.error(`--volume must be a Comic Vine volume id: ${volumeArg}`);
  process.exit(1);
}
const startedAt = new Date().toISOString();

const supabase = await createTypedStepClient();

/**
 * The issue's Comic Vine cast: the stored column when it holds one, else a
 * fetch into memory when a volume id is known. `inMemory` marks a fetched
 * cast, which the naming call then gets in place of the (null) column.
 */
async function comicvineCast(): Promise<{
  cast: ComicVineCharacter[];
  inMemory: boolean;
  wiki: LookaheadWikiAppearance[];
}> {
  // With --cast-only and --volume, read neither #851 column.
  const skipNewColumns = CAST_ONLY && VOLUME !== undefined;
  const { data: issue, error } = skipNewColumns
    ? await selectIssue(
        supabase,
        BOOK_ID,
        ISSUE_ID,
        "number, wiki_appearances",
      ).single()
    : await selectIssue(
        supabase,
        BOOK_ID,
        ISSUE_ID,
        "number, wiki_appearances, comicvine_characters",
      ).single();
  if (error) throw new Error(`issues read failed: ${error.message}`);
  const wiki =
    (issue.wiki_appearances as LookaheadWikiAppearance[] | null) ?? [];
  const stored =
    "comicvine_characters" in issue
      ? parseComicVineCharacters(issue.comicvine_characters)
      : null;
  if (stored) {
    console.log(`comicvine: ${stored.length} credit(s) stored on the issue`);
    return { cast: stored, inMemory: false, wiki };
  }

  let volume = VOLUME;
  if (volume === undefined) {
    const { data: book, error: bookErr } = await supabase
      .from("books")
      .select("comicvine_volume_id")
      .eq("id", BOOK_ID)
      .single();
    if (bookErr) throw new Error(`books read failed: ${bookErr.message}`);
    volume = book.comicvine_volume_id ?? undefined;
  }
  const apiKey = process.env.COMICVINE_API_KEY;
  if (volume === undefined || !apiKey) {
    console.log(
      `comicvine: none (${volume === undefined ? "no volume id" : "COMICVINE_API_KEY unset"})`,
    );
    return { cast: [], inMemory: false, wiki };
  }
  const cast = await fetchComicVineCast(apiKey, volume, Number(issue.number));
  console.log(
    `comicvine: ${cast.length} credit(s) fetched in memory (volume ${volume}, issue ${issue.number}), not stored`,
  );
  return { cast, inMemory: true, wiki };
}

const comicvine = await comicvineCast();

if (CAST_ONLY) {
  const dbCharacters = await buildKnownCharacterListOrFatal(
    supabase,
    BOOK_ID,
    "cast-only",
  );
  const { knownCharacters, castLooks } = buildLookaheadCast(
    dbCharacters,
    comicvine.wiki,
    comicvine.cast,
  );
  const before = buildLookaheadCast(dbCharacters, comicvine.wiki, []);
  console.log(
    `\nname list: ${knownCharacters.length} name(s), ${knownCharacters.length - before.knownCharacters.length} from Comic Vine`,
  );
  console.log(`Named characters who may appear: ${knownCharacters.join(", ")}`);
  console.log(`\nlooks hint: ${castLooks.length} line(s)`);
  console.log(characterIdentification.castLooksBlock(castLooks) || "(none)");
  process.exit(0);
}

async function issuePageNumbers(): Promise<number[]> {
  const { data, error } = await supabase
    .from("pages")
    .select("number")
    .eq("book_id", BOOK_ID)
    .eq("issue_id", ISSUE_ID)
    .order("number");
  if (error) throw new Error(`pages read failed: ${error.message}`);
  return data.map((p) => p.number);
}

const pagesArg = arg("pages");
const pageNumbers = pagesArg
  ? pagesArg.split(",").map((s) => Number(s.trim()))
  : await issuePageNumbers();
if (pageNumbers.some((n) => !Number.isInteger(n) || n < 1)) {
  console.error(`--pages must be a comma list of page numbers: ${pagesArg}`);
  process.exit(1);
}

console.log(`${BOOK_ID}/${ISSUE_ID}, pages ${pageNumbers.join(",")}`);

const plannedCalls = (page: LookaheadPage) => {
  const perPanel = new Map<string, number>();
  for (const c of page.crops) {
    perPanel.set(c.panelId, (perPanel.get(c.panelId) ?? 0) + 1);
  }
  let calls = 0;
  for (const n of perPanel.values()) {
    calls += Math.ceil(n / PANEL_FACE_BATCH_MAX);
  }
  return { panels: perPanel.size, calls };
};

const pages: LookaheadPage[] = [];
let totalCrops = 0;
let totalCalls = 0;
for (const pageNumber of pageNumbers) {
  const page = await loadLookaheadPageOrFatal(
    deps,
    supabase,
    BOOK_ID,
    ISSUE_ID,
    pageNumber,
    { skipIfStored: false },
  );
  if ("skip" in page) {
    console.log(`page ${pageNumber}: ${page.skip}`);
    continue;
  }
  const { panels, calls } = plannedCalls(page);
  console.log(
    `page ${pageNumber}: ${page.crops.length} crop(s) in ${panels} panel(s), ${calls} naming call(s)`,
  );
  totalCrops += page.crops.length;
  totalCalls += calls;
  pages.push(page);
}
console.log(
  `total: ${totalCrops} crop(s), ${totalCalls} naming call(s) planned (before #845: ${totalCrops}), cap ${MAX_NAMING_CALLS}`,
);
if (COUNT_ONLY) process.exit(0);
if (totalCalls > MAX_NAMING_CALLS) {
  console.error("over the cap, not running");
  process.exit(1);
}

// The stored detections, read once for the issue: "before" for every face.
type StoredDetection = {
  panelId: string;
  pageNumber: number;
  x: number;
  y: number;
  label: string;
};

async function readStoredDetections(): Promise<StoredDetection[]> {
  const rows: StoredDetection[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("panel_character_detections")
      .select(
        "id, panel_id, face_bbox, character_id, suggested_name, panels!inner(book_id, issue_id, page_number)",
      )
      .eq("panels.book_id", BOOK_ID)
      .eq("panels.issue_id", ISSUE_ID)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `panel_character_detections read failed: ${error.message}`,
      );
    }
    for (const d of data) {
      const bbox = d.face_bbox as { x: number; y: number } | null;
      rows.push({
        panelId: d.panel_id,
        pageNumber: d.panels.page_number,
        x: bbox?.x ?? NaN,
        y: bbox?.y ?? NaN,
        label:
          d.character_id ?? (d.suggested_name ? `?${d.suggested_name}` : "∅"),
      });
    }
    if (data.length < PAGE_SIZE) return rows;
  }
}

const stored = await readStoredDetections();

const isName = (label: string) => label !== "∅" && label !== "(dropped)";

function beforeLabel(f: IdentifiedFace): string {
  const { panelId, bboxPanelLocal: b } = f.crop;
  const row = stored.find(
    (d) =>
      d.panelId === panelId &&
      Math.abs(d.x - b.x) < 1e-6 &&
      Math.abs(d.y - b.y) < 1e-6,
  );
  return row ? row.label : "(dropped)";
}

function afterLabel(f: IdentifiedFace): string {
  if (f.outcome === "named") {
    return f.characterId ?? `?${f.result.characterName}`;
  }
  return f.outcome === "unnamed" ? "∅" : "(dropped)";
}

const sorted = (s: Set<string>) => [...s].sort().join(", ") || "(none)";
const minus = (a: Set<string>, b: Set<string>) =>
  new Set([...a].filter((x) => !b.has(x)));

function printCastDiff(label: string, before: Set<string>, after: Set<string>) {
  console.log(`${label} before: ${sorted(before)}`);
  console.log(`${label} after:  ${sorted(after)}`);
  console.log(
    `${label} lost: ${sorted(minus(before, after))}; gained: ${sorted(minus(after, before))}`,
  );
}

// Each page prints as soon as it is done, so a failed call later in the run
// does not lose the replies already paid for.
const issueBefore = new Set<string>();
const issueAfter = new Set<string>();
for (const page of pages) {
  const faces = await identifyLookaheadFacesOrFatal(
    deps,
    supabase,
    BOOK_ID,
    ISSUE_ID,
    page,
    STEP,
    comicvine.inMemory ? comicvine.cast : undefined,
  );
  console.log(`\npage | panel | before | after`);
  const pageAfter = new Set<string>();
  for (const f of faces) {
    const before = beforeLabel(f);
    const after = afterLabel(f);
    if (isName(after)) pageAfter.add(after);
    console.log(
      [
        f.position.pageNumber,
        f.position.panelSort,
        before,
        `${after}${before === after ? "" : "  *"}`,
      ].join(" | "),
    );
  }
  // Before is every named row stored on the page, matched to a crop or not.
  const pageBefore = new Set(
    stored
      .filter((d) => d.pageNumber === page.pageNumber && isName(d.label))
      .map((d) => d.label),
  );
  printCastDiff(`page ${page.pageNumber}`, pageBefore, pageAfter);
  for (const n of pageBefore) issueBefore.add(n);
  for (const n of pageAfter) issueAfter.add(n);
}

console.log("");
printCastDiff("issue", issueBefore, issueAfter);

const { data: calls, error: callsErr } = await supabase
  .from("llm_calls")
  .select("model, usd_est")
  .eq("step", STEP)
  .eq("book_id", BOOK_ID)
  .eq("issue_id", ISSUE_ID)
  .gte("created_at", startedAt);
if (callsErr) {
  console.error(`llm_calls read failed: ${callsErr.message}`);
  process.exit(1);
}
const byModel = new Map<string, { count: number; usd: number }>();
for (const c of calls) {
  const key = c.model ?? "(none)";
  const m = byModel.get(key) ?? { count: 0, usd: 0 };
  m.count++;
  m.usd += c.usd_est ?? 0;
  byModel.set(key, m);
}
console.log(`\nllm_calls under ${STEP} since ${startedAt}:`);
for (const [model, m] of byModel) {
  console.log(`${model}: ${m.count} call(s), $${m.usd.toFixed(4)}`);
}
