/**
 * Acceptance for the DRY_RUN fakes (#86). `fetch` throws and any read of an
 * `*_API_KEY` env var throws, then each wrapper runs once per purpose.
 * With `VERCEL_ENV` set it checks that every wrapper refuses to run.
 *
 * Usage: DRY_RUN=1 pnpm exec tsx --env-file=.env scripts/check-fakes.ts
 */
import assert from "node:assert/strict";

if (!process.env.DRY_RUN || process.env.DRY_RUN === "0") {
  console.error("refusing to run without DRY_RUN=1");
  process.exit(1);
}

globalThis.fetch = () => {
  throw new Error("check-fakes: fetch called");
};
process.env = new Proxy(process.env, {
  get(target, key) {
    if (typeof key === "string" && key.endsWith("_API_KEY")) {
      throw new Error(`check-fakes: read ${key}`);
    }
    return Reflect.get(target, key) as string | undefined;
  },
});

const { getGeminiClient, getFallbackGeminiClient } = await import(
  "~/lib/gemini-client"
);
const { embedImage, embedText } = await import("~/lib/embeddings");
const { runRoboflowWorkflow } = await import("~/lib/roboflow-client");
const { getElevenLabsClient, elevenLabsFetch } = await import(
  "~/lib/elevenlabs-client"
);
const { identifyFace } = await import("~/lib/character-identification");
const { resetFakeCursors } = await import("~/lib/fakes/gemini");
const { loadIngestFixture } = await import("~/lib/fakes/dry-run");
const { buildContextPrompt } = await import("~/lib/gemini-prompts");
const { buildCuePrompt } = await import("~/lib/cue-rules");
const { parseRoboflowSam3Output } = await import(
  "~/workflows/steps/vision-rows"
);
const { GEMINI_FAST, GEMINI_HIGH, GEMINI_MEDIUM } = await import(
  "~/lib/models"
);
const { TTS_MODEL } = await import("~/lib/tts-request");
const { cloudVisionGeometry } = await import("~/lib/cloud-vision-geometry");

const post = { method: "POST", body: JSON.stringify({ voice_name: "x" }) };

if (process.env.VERCEL_ENV) {
  const calls: Record<string, () => unknown> = {
    getGeminiClient,
    embedText: () => embedText("hi"),
    runRoboflowWorkflow: () =>
      runRoboflowWorkflow("u", { type: "url", value: "v" }),
    getElevenLabsClient,
    elevenLabsFetch: () => elevenLabsFetch("/v1/text-to-voice", post),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(async () => call(), /DRY_RUN is local-only/);
    console.log(`${name}: threw "DRY_RUN is local-only"`);
  }
  process.exit(0);
}

console.log(`scenario=${process.env.DRY_RUN_SCENARIO ?? "clean"}`);

for (const page of [1, 2]) {
  const res = await runRoboflowWorkflow("https://roboflow.invalid", {
    type: "url",
    value: `https://storage.invalid/page-0${page}.webp`,
  });
  const data = (await res.json()) as { outputs: unknown[] };
  const parsed = parseRoboflowSam3Output(data.outputs[0] as never);
  assert.ok(parsed, "SAM3 output parses");
  console.log(
    `roboflow p${page} panels=${parsed.panelPredictions.length} bubbles=${parsed.bubblePredictions.length} segments=${parsed.segmentationPredictions.length}`,
  );
}
const fallback = await runRoboflowWorkflow("https://roboflow.invalid", {
  type: "base64",
  value: "AAAA",
});
const fb = (await fallback.json()) as {
  outputs: Array<{ predictions: { predictions: unknown[] } }>;
};
console.log(
  `roboflow text-detection bubbles=${fb.outputs[0]!.predictions.predictions.length}`,
);

const ocrGeometry = await cloudVisionGeometry(new Uint8Array([1, 2, 3]));
assert.equal(ocrGeometry.engine, "cloud-vision@v1");
assert.equal(ocrGeometry.lines.length, 0);
console.log(
  `cloud vision: engine=${ocrGeometry.engine} lines=${ocrGeometry.lines.length}`,
);

const gemini = getGeminiClient();
assert.equal(getFallbackGeminiClient(), null);
const ask = async (model: string, prompt: string) =>
  (await gemini.models.generateContent({ model, contents: [prompt] })).text!;

const ocrText = await ask(
  GEMINI_MEDIUM,
  "Extract all text from this comic book speech bubble. Return ONLY the text exactly as it appears. No explanation or formatting.",
);
console.log(`gemini ocr: ${JSON.stringify(ocrText)}`);

const box = { x: 0, y: 0, width: 10, height: 10 };
const ctx = await ask(GEMINI_HIGH, buildContextPrompt(ocrText, box, []));
const ctxJson = JSON.parse(/\{[\s\S]*\}/.exec(ctx)![0]) as { speaker: string };
console.log(`gemini context: speaker=${ctxJson.speaker}`);
await assert.rejects(
  ask(GEMINI_HIGH, buildContextPrompt("NOT A FIXTURE", box, [])),
  /no context fixture for "NOT A FIXTURE"/,
);
console.log("gemini context unmatched text: threw");

const cueBubble = loadIngestFixture()
  .pages.flatMap((p) => p.bubbles)
  .find((b) => b.textWithCues)!;
const cue = await ask(
  GEMINI_FAST,
  buildCuePrompt({
    text: cueBubble.ocrText,
    emotion: cueBubble.emotion,
    speaker: cueBubble.speaker,
  }),
);
assert.equal(cue, cueBubble.textWithCues);
console.log(`gemini cues: ${JSON.stringify(cue)}`);
await assert.rejects(
  ask(
    GEMINI_FAST,
    buildCuePrompt({ text: "NOT A FIXTURE", emotion: null, speaker: null }),
  ),
  /no cue fixture for "NOT A FIXTURE"/,
);
console.log("gemini cues unmatched text: threw");

const face = await identifyFace(gemini, "AAAA", "image/jpeg", ["Raphael"]);
console.log(
  `gemini face-id: ${face.characterName} confidence=${face.confidence}`,
);
if (process.env.DRY_RUN_SCENARIO === "gates") {
  // A second run in the same process must see the unresolved face again.
  resetFakeCursors();
  const again = await identifyFace(gemini, "AAAA", "image/jpeg", []);
  assert.equal(again.characterName, "smoke-stranger");
  console.log(`gemini face-id after resetFakeCursors: ${again.characterName}`);
}

const sort = await ask(
  GEMINI_MEDIUM,
  "You are analyzing a comic book page image.\n- panelId: p1\n- panelId: p2\n- bubbleId: b1\n  assigned_panelId: p2\n- bubbleId: b2\n  assigned_panelId: p1\n",
);
const sortPlan = JSON.parse(sort) as {
  panels: Array<{ bubbles: unknown[] }>;
};
assert.equal(sortPlan.panels.length, 2);
assert.equal(
  sortPlan.panels.reduce((n, p) => n + p.bubbles.length, 0),
  2,
);
console.log(`gemini sort: ${sort}`);

const voice = await ask(
  GEMINI_MEDIUM,
  'Consolidate these voice description snippets into one.\n\nCharacter: "smoke-tessik"\n',
);
assert.equal(voice, loadIngestFixture().voiceDescriptions["smoke-tessik"]);
console.log(`gemini voice-description: ${voice.slice(0, 60)}...`);

const a = await embedText("Raphael");
assert.equal(a.length, 768);
assert.deepEqual(a, await embedText("Raphael"));
assert.notDeepEqual(a, await embedImage("AAAA"));
console.log(`gemini embedding: dims=${a.length} deterministic=true`);

await assert.rejects(ask(GEMINI_FAST, "Something new"), /no Gemini fixture/);
console.log("gemini unmatched prompt: threw");

const tts = await (
  await getElevenLabsClient()
).textToSpeech.convertWithTimestamps("voice", {
  text: ocrText,
  modelId: TTS_MODEL,
});
const audio = Buffer.from(tts.audioBase64, "base64");
assert.equal(tts.alignment!.characters.join(""), ocrText);
console.log(
  `elevenlabs tts: chars=${ocrText.length} mp3Bytes=${audio.length} lastCharEnd=${tts.alignment!.characterEndTimesSeconds.at(-1)}s`,
);

const design = await elevenLabsFetch("/v1/text-to-voice/design", {
  method: "POST",
  body: JSON.stringify({ voice_description: voice }),
});
const create = await elevenLabsFetch("/v1/text-to-voice", post);
console.log(
  `elevenlabs design: ${JSON.stringify(await design.json())} create: ${JSON.stringify(await create.json())}`,
);
console.log("check-fakes: ok");
