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
