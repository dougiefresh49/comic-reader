/**
 * #348 dry run: lookahead's naming call and face grouping on the smoke
 * pages, with no DB write. It runs the step's own crop, embedding and naming
 * code (`loadLookaheadPageOrFatal`, `identifyLookaheadFacesOrFatal`) and the
 * same `groupFaces`, then prints what lookahead would store for each face.
 * The only writes are the `llm_calls` rows the Gemini wrapper logs, under
 * step `dry-run-unnamed-faces`.
 *
 * Paid: one embedding and one Gemini naming call per crop.
 *   pnpm exec tsx --env-file=.env scripts/dry-run-unnamed-faces.ts --count-only
 *   LIVE_API_OK=1 pnpm exec tsx --env-file=.env scripts/dry-run-unnamed-faces.ts
 */
import sharp from "sharp";
import * as characterIdentification from "~/lib/character-identification";
import * as exemplarStore from "~/lib/exemplar-store";
import * as faceExtraction from "~/lib/face-extraction";
import { groupFaces } from "~/lib/face-groups";
import * as geminiClient from "~/lib/gemini-client";
import * as llmUsage from "~/lib/llm-usage";
import { createTypedStepClient } from "~/workflows/step-utils";
import {
  compareFacePosition,
  identifyLookaheadFacesOrFatal,
  loadLookaheadPageOrFatal,
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

const BOOK_ID = "smoke-test";
const ISSUE_ID = "issue-smoke";
const PAGES = [1, 2];
/** A crop cost up to $0.006 in llm_calls, so 33 stay under the $0.20 cap. */
const MAX_CROPS = 33;
const STEP = "dry-run-unnamed-faces";

const supabase = await createTypedStepClient();

const pages: LookaheadPage[] = [];
for (const pageNumber of PAGES) {
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
  console.log(`page ${pageNumber}: ${page.crops.length} crop(s)`);
  pages.push(page);
}

const total = pages.reduce((n, p) => n + p.crops.length, 0);
console.log(`total: ${total} crop(s), cap ${MAX_CROPS}`);
if (process.argv.includes("--count-only")) process.exit(0);
if (total > MAX_CROPS) {
  console.error(`over the cap, not running`);
  process.exit(1);
}

// Each page prints as soon as it is done, so a failed call later in the run
// does not lose the replies already paid for.
console.log(
  "\nface | page | panel | is_face | name | confidence | lookahead would | reasoning",
);
const faces: IdentifiedFace[] = [];
for (const page of pages) {
  const pageFaces = await identifyLookaheadFacesOrFatal(
    deps,
    supabase,
    BOOK_ID,
    ISSUE_ID,
    page,
    STEP,
  );
  for (const f of pageFaces) {
    const r = f.result;
    faces.push(f);
    console.log(
      [
        `#${faces.length}`,
        f.position.pageNumber,
        f.position.panelSort,
        r.isFace ?? "(missing)",
        r.characterName ?? "null",
        r.confidence,
        f.outcome === "named"
          ? `store named (${f.characterId ?? `suggested "${r.characterName}"`})`
          : f.outcome === "unnamed"
            ? "store unnamed"
            : "drop",
        r.reasoning ?? "",
      ].join(" | "),
    );
  }
}

// Lookahead groups the unnamed faces of the whole issue in this order.
const unnamed = faces
  .filter((f) => f.outcome === "unnamed")
  .sort((a, b) => compareFacePosition(a.position, b.position));
const groups = groupFaces(unnamed.map((f) => f.embedding));
console.log("\nunnamed face | group");
unnamed.forEach((f, i) => {
  console.log(`#${faces.indexOf(f) + 1} | ${groups[i]}`);
});

const counts = { named: 0, unnamed: 0, drop: 0 };
for (const f of faces) counts[f.outcome]++;
console.log(
  `\n${faces.length} face(s): ${counts.named} named, ${counts.unnamed} unnamed, ${counts.drop} dropped; ${unnamed.length} unnamed in ${groups.length > 0 ? Math.max(...groups) : 0} group(s)`,
);
