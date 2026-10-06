// Canonical Gemini / Venice model identifiers.
// Both src/ (Next.js) and scripts/ (tsx) import from here. Don't cross
// the boundary the other way — Next's webpack only bundles src/.

export const GEMINI_HIGH = "gemini-3.1-pro-preview"; // deep reasoning, page-level context
export const GEMINI_MEDIUM = "gemini-3.8-flash"; // vision tasks, OCR, moderate reasoning
export const GEMINI_FAST = "gemini-3.5-flash-lite"; // simple formatting/validation, no thinking needed
// image in, image out: removes a watermark from a page crop (#541). The
// cheapest image-output model in `models.list()` on 2026-10-06.
export const GEMINI_IMAGE_EDIT = "gemini-3.1-flash-lite-image";

// ─── Venice image models ───────────────────────────────────────────────────────
// Phase 1 — character reference images (text-to-image)
// $0.05/image | aspectRatios only (no width/height) | 10k char prompt limit
export const VENICE_IMAGE_CHAR_REF = "seedream-v5-lite";

// Phase 3 — storyboard panels: establishing/multi-character shots (text-to-image)
export const VENICE_IMAGE_STORYBOARD = "seedream-v5-lite";

// Phase 3 — storyboard panels: single-character shots via image editing
// POST /image/edit, returns binary PNG, no negative_prompt
export const VENICE_IMAGE_EDIT_CHAR = "seedream-v5-lite-edit";

// ─── Venice video models (Phase 4+) ───────────────────────────────────────────
// Character shots: R2V model, accepts reference_image_urls for identity
export const VENICE_VIDEO_CHARACTER = "kling-o3-pro-reference-to-video";

// Atmosphere/establishing shots: standard image-to-video
export const VENICE_VIDEO_ATMOSPHERE = "seedance-2-0-image-to-video";

// ─── Estimated rates for llm_calls.usd_est (#93) ──────────────────────────────
// Keyed by the tier constants above: when a model string changes (#104),
// change its rate here too. USD per 1M tokens; thinking bills as output.
// Rates read from https://ai.google.dev/gemini-api/docs/pricing on 2026-10-05
// (#436). GEMINI_MEDIUM's is the price through 2026-12-31: from 2027-01-01
// gemini-3.8-flash is $1.50 in and $7.50 out, and this row must change then.
export const GEMINI_USD_PER_1M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  [GEMINI_HIGH]: { input: 2.0, output: 12.0 },
  [GEMINI_MEDIUM]: { input: 0.75, output: 3.75 },
  [GEMINI_FAST]: { input: 0.3, output: 2.5 },
  // output is image tokens: 1120 per 1K image (#541)
  [GEMINI_IMAGE_EDIT]: { input: 0.25, output: 30.0 },
};

// GEMINI_IMAGE_EDIT, per 1K output image (pricing page, 2026-10-06). The
// llm_calls row prices from the token rate above; this is for estimates.
export const GEMINI_IMAGE_EDIT_USD_PER_IMAGE = 0.0336;

// gemini-embedding-2, per image embedded. Text embeddings have no rate yet.
export const GEMINI_EMBEDDING_USD_PER_IMAGE = 0.00012;

// owner's ElevenLabs pricing table, 2026-09-30: $0.08 per 1K characters on
// Creator for v3 TTS; v4 lists at the same price (#213)
export const ELEVENLABS_USD_PER_CHARACTER = 0.00008;

// Fallback credits per character when `character-cost` is absent (#251).
// TTS eleven_v4: `GET /v1/models` reports `character_cost_multiplier: 1.0`
// on this account (#213 probe, 2026-09-28).
// Voice Design v3 bills preview text once for all three samples. Its FAQ says
// credits equal preview characters and calls this the single-credit rule:
// https://elevenlabs.io/blog/voice-design-v3
// https://help.elevenlabs.io/hc/en-us/articles/29315418701073-How-much-does-Voice-Design-cost
// Models without a documented rate keep credits null.
export const ELEVENLABS_CREDITS_PER_CHARACTER: Record<string, number> = {
  eleven_v4: 1,
  eleven_ttv_v3: 1,
};
