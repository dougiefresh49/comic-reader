/**
 * Fixture-only acceptance for vision row mappers (#70), for the vision
 * failures that must surface (#145), and for complete panel audio_tags
 * (#222). No DB calls and no network calls:
 * `fetch` is stubbed before any case runs.
 *
 * Usage: pnpm tsx --env-file=.env scripts/check-vision-rows.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FatalError } from "workflow";
import type { GoogleGenAI } from "@google/genai";
import { identifyFace } from "~/lib/character-identification";
import { embedImage } from "~/lib/embeddings";
import * as exemplarStore from "~/lib/exemplar-store";
import type { Database } from "~/types/database";
import {
  exemplarRefsOrFatal,
  hasStoredFaceDetections,
  identifyFaceOrFatal,
  readSam3Response,
  roboflowTextPredictionsOrFatal,
} from "~/workflows/steps/vision";
import {
  bubbleHasContext,
  mapBubbleRows,
  mapPanelRows,
  mapSegmentationRow,
  normalizePanelAudioTags,
  parseRoboflowSam3Output,
  type BubbleContextFields,
  type RoboflowBoxPrediction,
  type RoboflowSam3Output,
  type RoboflowSegPrediction,
} from "~/workflows/steps/vision-rows";

type Fixture = {
  panel_predictions: {
    image: { width: number; height: number };
    predictions: RoboflowBoxPrediction[];
  };
  bubble_predictions: {
    predictions: RoboflowBoxPrediction[];
  };
  segmentation_predictions: {
    predictions: RoboflowSegPrediction[];
  };
};

const fixturePath = resolve("fixtures/vision/roboflow-issue1-p03.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const bookId = "tmnt-mmpr-iii";
const issueId = "issue-1";
const pageNumber = 3;
const imgDims = fixture.panel_predictions.image;

const panelRows = mapPanelRows(
  bookId,
  issueId,
  pageNumber,
  fixture.panel_predictions.predictions,
  imgDims,
);
const bubbleRows = mapBubbleRows(
  bookId,
  issueId,
  pageNumber,
  fixture.bubble_predictions.predictions,
);
const segRow = mapSegmentationRow(
  bookId,
  issueId,
  pageNumber,
  imgDims,
  fixture.segmentation_predictions.predictions,
);

console.log(`panels: ${panelRows.length}`);
for (const row of panelRows) {
  console.log(
    `  ${row.panel_id} source=${row.source as string} sort_order=${row.sort_order}`,
  );
}

console.log(`bubbles: ${bubbleRows.length}`);
for (const row of bubbleRows) {
  console.log(
    `  ${row.legacy_id as string} sort_order=${row.sort_order} box_2d.keys=${Object.keys((row.box_2d as object) ?? {}).join(",")}`,
  );
}

console.log(
  `segmentation: 1 row page_number=${segRow.page_number} preds=${Array.isArray(segRow.predictions) ? segRow.predictions.length : "?"}`,
);

const expectedIds = [
  "p03-01",
  "p03-02",
  "p03-03",
  "p03-04",
  "p03-05",
  "p03-06",
];
const actualIds = panelRows.map((r) => r.panel_id);
if (panelRows.length !== 6) {
  console.error(`expected 6 panel rows, got ${panelRows.length}`);
  process.exit(1);
}
for (let i = 0; i < expectedIds.length; i++) {
  if (actualIds[i] !== expectedIds[i]) {
    console.error(
      `panel id mismatch at ${i}: ${actualIds[i]} != ${expectedIds[i]}`,
    );
    process.exit(1);
  }
  if (panelRows[i]!.source !== "roboflow") {
    console.error(`panel ${actualIds[i]} source is not roboflow`);
    process.exit(1);
  }
}

if (bubbleRows.length === 0) {
  console.error("expected bubble rows");
  process.exit(1);
}
for (const row of bubbleRows) {
  if (typeof row.sort_order !== "number") {
    console.error(`bubble ${row.legacy_id as string} missing sort_order`);
    process.exit(1);
  }
}

const rows: object[] = [...panelRows, ...bubbleRows, segRow];
for (const row of rows) {
  if (Object.prototype.hasOwnProperty.call(row, "confidence")) {
    console.error("row has top-level confidence key:", row);
    process.exit(1);
  }
}

const contextCases: BubbleContextFields[] = [
  {
    ocr_text: null,
    text_with_cues: null,
    speaker: null,
    ignored: false,
  },
  {
    ocr_text: "hello",
    text_with_cues: null,
    speaker: null,
    ignored: false,
  },
  {
    ocr_text: null,
    text_with_cues: null,
    speaker: "Leonardo",
    ignored: false,
  },
  {
    ocr_text: null,
    text_with_cues: null,
    speaker: null,
    ignored: true,
  },
];
const needingContext = contextCases.filter((b) => !bubbleHasContext(b));
if (needingContext.length !== 1 || needingContext[0] !== contextCases[0]) {
  console.error(
    `bubbleHasContext: expected only the null-everything bubble, got ${needingContext.length}`,
  );
  process.exit(1);
}
console.log(
  `bubbleHasContext: ${needingContext.length}/4 bubbles need context (null everything only)`,
);

const emptySeg = mapSegmentationRow(bookId, issueId, pageNumber, imgDims, []);
if (
  !emptySeg ||
  emptySeg.page_number !== pageNumber ||
  !Array.isArray(emptySeg.predictions) ||
  emptySeg.predictions.length !== 0
) {
  console.error(
    "mapSegmentationRow([]) did not return one empty-predictions row",
  );
  process.exit(1);
}
console.log(
  `empty segmentation: 1 row page_number=${emptySeg.page_number} preds=${emptySeg.predictions.length}`,
);

const emptyValid: RoboflowSam3Output = {
  panel_predictions: { image: { width: 100, height: 100 }, predictions: [] },
  bubble_predictions: { predictions: [] },
  segmentation_predictions: { predictions: [] },
};
if (parseRoboflowSam3Output(emptyValid) === null) {
  console.error("all-three-empty should be valid");
  process.exit(1);
}

const missingPanels: RoboflowSam3Output = {
  bubble_predictions: { predictions: [] },
  segmentation_predictions: { predictions: [] },
};
if (parseRoboflowSam3Output(missingPanels) !== null) {
  console.error("missing panels should be malformed");
  process.exit(1);
}

const missingBubbles: RoboflowSam3Output = {
  panel_predictions: { image: { width: 100, height: 100 }, predictions: [] },
  segmentation_predictions: { predictions: [] },
};
if (parseRoboflowSam3Output(missingBubbles) !== null) {
  console.error("missing bubbles should be malformed");
  process.exit(1);
}

const missingSeg: RoboflowSam3Output = {
  panel_predictions: { image: { width: 100, height: 100 }, predictions: [] },
  bubble_predictions: { predictions: [] },
};
if (parseRoboflowSam3Output(missingSeg) !== null) {
  console.error("missing segmentation should be malformed");
  process.exit(1);
}

const nonArrayBubbles: RoboflowSam3Output = {
  panel_predictions: { image: { width: 100, height: 100 }, predictions: [] },
  bubble_predictions: { predictions: undefined },
  segmentation_predictions: { predictions: [] },
};
if (parseRoboflowSam3Output(nonArrayBubbles) !== null) {
  console.error("non-array bubble predictions should be malformed");
  process.exit(1);
}

console.log(
  "parseRoboflowSam3Output: missing panels/bubbles/seg rejected; all-empty accepted",
);

// #145: each failure surfaces. Fake Responses, a fake Supabase client, the
// DRY_RUN embedding fake, and a fetch stub that answers only the 429 cases.
globalThis.fetch = () => Promise.reject(new Error("network blocked"));
type Res = { data?: unknown; error?: { message: string }; count?: number };
function fakeClient(tables: Record<string, Res> = {}, rpc = {}, dl = {}) {
  const writes: string[] = [];
  const query = (table: string): unknown => {
    const q: Record<string, unknown> = {
      then: (ok: (r: Res) => void) => ok({ data: null, ...tables[table] }),
    };
    for (const m of ["select", "eq", "in", "limit", "order"]) q[m] = () => q;
    q.insert = () => (writes.push(`insert ${table}`), q);
    return q;
  };
  const client = {
    from: query,
    rpc: async () => ({ data: null, error: null, ...rpc }),
    storage: {
      from: (b: string) => ({
        download: async () => ({ data: null, error: null, ...dl }),
        upload: async () => (writes.push(`upload ${b}`), { error: null }),
      }),
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, writes };
}

let failed = 0;
async function check(name: string, run: () => Promise<unknown>, want: RegExp) {
  let got: string;
  try {
    got = `returned ${JSON.stringify(await run())}`;
  } catch (e) {
    got = `threw ${e instanceof FatalError ? "FatalError" : "Error"}: ${(e as Error).message}`;
  }
  const pass = want.test(got);
  if (!pass) failed++;
  console.log(`${pass ? "pass" : "FAIL"} ${name}: ${got}`);
}

const badCalls: Record<string, () => Promise<Response>> = {
  "fetch rejected": () => Promise.reject(new Error("ECONNRESET")),
  "500, body unreadable": async () =>
    new Response(
      new ReadableStream({
        start: (c) => c.error(new Error("socket hang up")),
      }),
      { status: 500 },
    ),
  "non-JSON body": async () => new Response("<html>oops</html>"),
  "JSON null body": async () => new Response("null"),
  "no predictions": async () => new Response('{"outputs":[{}]}'),
};
for (const [name, call] of Object.entries(badCalls)) {
  await check(
    `SAM3 ${name}`,
    () => readSam3Response(call),
    /^returned \{"failure"/,
  );
  await check(
    `text fallback ${name}`,
    () => roboflowTextPredictionsOrFatal(call, "page-03"),
    /^threw FatalError: Roboflow text detection failed for page-03/,
  );
}
await check(
  "text fallback, no text regions",
  () =>
    roboflowTextPredictionsOrFatal(
      async () =>
        new Response('{"outputs":[{"predictions":{"predictions":[]}}]}'),
      "page-03",
    ),
  /^returned \[\]$/,
);

await check(
  "text fallback, [null] entry",
  () =>
    roboflowTextPredictionsOrFatal(
      async () =>
        new Response('{"outputs":[{"predictions":{"predictions":[null]}}]}'),
      "page-03",
    ),
  /^threw FatalError: Roboflow text detection failed for page-03: prediction 0 is not a box/,
);
process.env.DRY_RUN = "1";
const rpcDown = fakeClient({}, { error: { message: "rpc timeout" } }).client;
await check(
  "findSimilarExemplars rpc error",
  () => exemplarStore.findSimilarExemplars(rpcDown, "AAAA", [bookId]),
  /threw Error: match_face_exemplars rpc failed: rpc timeout/,
);
await check(
  "findSimilarExemplars no rows",
  () =>
    exemplarStore.findSimilarExemplars(fakeClient().client, "AAAA", [bookId]),
  /^returned \[\]$/,
);
await check(
  "exemplar lookup rpc error",
  () => exemplarRefsOrFatal(exemplarStore, rpcDown, "AAAA", bookId, "page-03"),
  /threw FatalError: exemplar lookup failed for page-03: match_face_exemplars/,
);
const dlDown = fakeClient(
  {},
  {},
  { error: { message: "Object not found" } },
).client;
await check(
  "downloadExemplarImage error",
  () => exemplarStore.downloadExemplarImage(dlDown, "a/b.jpg"),
  /threw Error: face-exemplars download failed for a\/b.jpg/,
);
await check(
  "downloadExemplarImage no data",
  () => exemplarStore.downloadExemplarImage(fakeClient().client, "a/b.jpg"),
  /^returned null$/,
);
const dupDown = fakeClient({
  character_face_exemplars: { error: { message: "read timeout" } },
});
const params = {
  jpegBuffer: Buffer.from("x"),
  characterId: "leonardo",
  bookId,
  sourceIssue: issueId,
  pageNumber,
  confidence: 0.9,
  isConfirmed: true,
};
await check(
  "storeExemplar duplicate check error",
  () => exemplarStore.storeExemplar(dupDown.client, params),
  /threw Error: character_face_exemplars read failed: read timeout/,
);
await check(
  "storeExemplar wrote nothing",
  async () => dupDown.writes,
  /^returned \[\]$/,
);

const dets = (r: Res) => fakeClient({ panel_character_detections: r }).client;
await check(
  "lookahead rerun, detections stored",
  () => hasStoredFaceDetections(dets({ count: 2 }), ["p1"], "page-03"),
  /^returned true$/,
);
await check(
  "lookahead rerun, half-done page",
  () => hasStoredFaceDetections(dets({ count: 0 }), ["p1"], "page-03"),
  /^returned false$/,
);
await check(
  "lookahead detections read error",
  () =>
    hasStoredFaceDetections(
      dets({ error: { message: "boom" } }),
      ["p1"],
      "page-03",
    ),
  /threw FatalError: panel_character_detections read failed for page-03/,
);

// The real identifyFace on the step's path, with a mocked generateContent.
const gemini = (answer: () => Promise<unknown>) =>
  ({ models: { generateContent: answer } }) as unknown as GoogleGenAI;
const apiError = (status: number) => () =>
  Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));
const identify = (primary: GoogleGenAI, fallback: GoogleGenAI | null) =>
  identifyFaceOrFatal(
    (c) =>
      identifyFace(
        c,
        "AAAA",
        "image/jpeg",
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        { throwOnApiError: true },
      ),
    primary,
    () => fallback,
    "page-03",
  );
await check(
  "face identification 500",
  () => identify(gemini(apiError(500)), gemini(apiError(500))),
  /^threw FatalError: Gemini face identification failed for page-03: HTTP 500/,
);
await check(
  "face identification 429 on both keys",
  () => identify(gemini(apiError(429)), gemini(apiError(429))),
  /^threw FatalError: Gemini face identification failed for page-03: HTTP 429/,
);
await check(
  "face identification, no match",
  () =>
    identify(
      gemini(async () => ({ text: '{"character_name":null,"confidence":0}' })),
      null,
    ),
  /^returned \{"characterName":null,"confidence":0\}$/,
);

process.env.DRY_RUN = "0";
process.env.GEMINI_API_KEY = "primary-key";
process.env.GEMINI_API_KEY_2 = "fallback-key";
let okKey = "fallback-key";
globalThis.fetch = async (_url, init) => {
  const key = new Headers(init?.headers).get("x-goog-api-key");
  if (key === okKey)
    return new Response('{"embeddings":[{"values":[0.1,0.2]}]}');
  return new Response('{"error":{"code":429,"message":"quota"}}', {
    status: 429,
  });
};
await check(
  "embedding 429, fallback key answers",
  () => embedImage("AAAA"),
  /^returned \[0.1,0.2\]$/,
);
okKey = "none";
await check(
  "embedding 429 on both keys",
  () =>
    exemplarRefsOrFatal(
      exemplarStore,
      fakeClient().client,
      "AAAA",
      bookId,
      "page-03",
    ),
  /threw FatalError: exemplar lookup failed for page-03: Gemini embedding failed/,
);

// #222: a panel row whose audio_tags is `{}` 500'd the reader. Every stored
// value comes back with all three keys, and the mapper writes all three.
const fullTags = String.raw`\{"ambience":\[\],"sfx":\[\],"music_mood":"transition_neutral"\}`;
const tagCases: Record<string, unknown> = {
  "{}": {},
  null: null,
  "a string": "oops",
  "wrong-typed fields": { ambience: "rain", sfx: [1], music_mood: 3 },
};
for (const [name, stored] of Object.entries(tagCases)) {
  await check(
    `audio_tags ${name}`,
    async () => normalizePanelAudioTags(stored),
    new RegExp(`^returned ${fullTags}$`),
  );
}
await check(
  "audio_tags partial keeps sfx",
  async () => normalizePanelAudioTags({ sfx: ["boom"] }),
  /^returned \{"ambience":\[\],"sfx":\["boom"\],"music_mood":"transition_neutral"\}$/,
);
await check(
  "mapPanelRows audio_tags",
  async () => panelRows.map((r) => r.audio_tags),
  new RegExp(String.raw`^returned \[(${fullTags},){5}${fullTags}\]$`),
);

if (failed > 0) {
  console.error(`${failed} failure case(s) did not surface`);
  process.exit(1);
}
console.log("ok");
