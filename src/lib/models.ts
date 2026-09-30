// Canonical Gemini / Venice model identifiers.
// Both src/ (Next.js) and scripts/ (tsx) import from here. Don't cross
// the boundary the other way — Next's webpack only bundles src/.

export const GEMINI_HIGH = "gemini-3.1-pro-preview"; // deep reasoning, page-level context
export const GEMINI_MEDIUM = "gemini-3-flash-preview"; // vision tasks, OCR, moderate reasoning
export const GEMINI_FAST = "gemini-3.1-flash-lite"; // simple formatting/validation, no thinking needed

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
export const GEMINI_USD_PER_1M_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  [GEMINI_HIGH]: { input: 2.0, output: 12.0 },
  [GEMINI_MEDIUM]: { input: 0.5, output: 3.0 },
  [GEMINI_FAST]: { input: 0.25, output: 1.5 },
};

// gemini-embedding-2, per image embedded. Text embeddings have no rate yet.
export const GEMINI_EMBEDDING_USD_PER_IMAGE = 0.00012;

// Assumption until the owner's invoice: Creator plan, $22 for 100k credits,
// 1 credit per character on eleven_v3.
export const ELEVENLABS_USD_PER_CHARACTER = 0.00022;

// ─── ElevenLabs credits for llm_calls.credits (#251) ──────────────────────────
// ElevenLabs bills a subscription in credits, so credits are what an issue
// really spends and the dollar figure above is our own estimate.
//
// No response header or body field reports the credits a single TTS request
// used. The API reference for create speech and stream speech documents no
// such header (read 2026-09-29, no call made), and the JS SDK's fetcher
// exposes the response headers only to its logger, not to a caller. So the
// figure is computed from the character count, which is what the request
// bills on.
//
// Rates per character, from https://elevenlabs.io/pricing (read 2026-09-29,
// no call made):
//
//   - "1 text character equals 1 credit" for V2 Multilingual.
//   - Flash and Turbo run "between 0.5 and 1 credit per character".
//   - v3 is priced on the same page at $0.08 per 1,000 characters as
//     Multilingual v2, and the docs give no separate credit rate for it, so
//     it takes the v2 figure of 1 credit per character. The owner's usage
//     page is the check (#251 runs it); this constant is the thing to correct
//     when it disagrees.
//
// A model with no entry here records credits null rather than a guess.
export const ELEVENLABS_CREDITS_PER_CHARACTER: Record<string, number> = {
  eleven_v3: 1,
};
