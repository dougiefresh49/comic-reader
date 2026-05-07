# Workflow vs Script Pipeline: Divergence Audit

## Status: `review-needed`

Audit date: 2026-05-06

Compared every workflow step in `src/workflows/steps/` against its script counterpart in `scripts/`. The `characterLookaheadPage` divergence was already fixed. Below are the remaining findings.

---

## Fixed in this session

### 1. `getContextPage` — simplified Gemini prompt (HIGH impact)

**Was:** Bare-bones 5-line prompt with no classification instructions, no performance cue guidance, no scratchpad reasoning, no book context injection.

**Now:** Uses the full structured prompt from `scripts/utils/gemini-context.ts` via shared `src/lib/gemini-prompts.ts`. Includes bubble classification (SPEECH/NARRATION/CAPTION/SFX/BACKGROUND), side/importance classification, performance cue instructions with examples, scratchpad chain-of-thought. Also loads book name + franchises from DB for context injection. Extracts `aiReasoning` from scratchpad and stores it.

**Files changed:** `src/workflows/steps/vision.ts`, `src/lib/gemini-prompts.ts` (new)

### 2. `generateAudioBatch` — 3-case emotion mapping (HIGH impact)

**Was:** Only 3 emotion buckets (angry/scared → 0.3, excited/happy → 0.4, everything else → 0.5). No speed variation. Used plain `text` instead of `text_with_cues`. No `__SKIPPED__` voice sentinel check.

**Now:** Uses full 20+ emotion mapping from `scripts/generate-audio.ts` via shared `src/lib/voice-settings.ts`. Varies stability, style, AND speed per emotion. Uses `text_with_cues` for TTS. Respects `__SKIPPED__` sentinel.

**Files changed:** `src/workflows/steps/generation.ts`, `src/lib/voice-settings.ts` (new)

### 3. `characterLookaheadPage` — no clustering, no exemplars (MEDIUM impact)

**Was:** Inline face extraction (no dedup), naive string-to-ID conversion, minimal prompt, no exemplar retrieval/storage.

**Now:** Uses shared modules for face extraction with IoU dedup, exemplar retrieval from pgvector before identification, exemplar storage after confirmed ID, alias-aware character resolution, key failover. Stores unresolved faces with `suggested_name`.

**Files changed:** `src/workflows/steps/vision.ts`, `src/lib/character-identification.ts`, `src/lib/exemplar-store.ts`, `src/lib/face-extraction.ts`, `src/lib/embeddings.ts`, `src/lib/gemini-client.ts` (all new)

---

## Needs review / input

### 4. `generateVoiceDescriptions` — missing book context in prompt (MEDIUM)

**File:** `src/workflows/steps/voice.ts:49-56`

The workflow prompt is generic: "Consolidate these voice description snippets into a single description." The script version injects the book title and `characterContext` instruction from `book-config.json` (e.g., franchise-specific voice guidance like "these are Teenage Mutant Ninja Turtles — give them youthful, energetic voices").

**Problem:** `characterContext` is not stored in the DB — it only exists in local `book-config.json` files.

**Options:**
- A) Add a `character_context` text column to the `books` table and populate it during book creation
- B) Use the `franchises` array already in `books` to generate a default context string
- C) Leave as-is — the voice descriptions are already generated per-bubble during `getContextPage`, this just consolidates them

**Recommendation:** Option A is cleanest. It's a one-column migration + one line of code. But this can wait — the prompt quality improvement is marginal since the individual voice descriptions already carry franchise context from `getContextPage`.

### 5. `generateVoiceModel` — no IVC vs voice_design distinction (MEDIUM)

**File:** `src/workflows/steps/generation.ts:38-135`

The workflow creates ElevenLabs Voice Design voices for ALL characters without a `voice_id`. The script version checks the voice registry and skips characters whose source is IVC (instant voice cloning) — those need manual clip preparation and a different API call.

**Problem:** The workflow would waste ElevenLabs credits creating wrong voices for characters meant to use IVC.

**Options:**
- A) Add a `voice_source` column to `characters` or `castlist` (values: `voice_design`, `ivc`, `existing`). Skip `voice_design` generation for non-`voice_design` characters.
- B) Handle this in the casting review pause point — the admin UI already marks which characters get voice_design vs IVC. Only characters explicitly marked for voice_design proceed to auto-generation.

**Recommendation:** Option B — the casting pause point already exists in the workflow. The fix is to filter in `getCharactersNeedingVoices()` to only return characters whose casting method is `voice_design`. Needs to know how casting decisions are stored in the DB.

### 6. `extractForegroundMasksBatch` — missing bubble polygon extraction (LOW)

**File:** `src/workflows/steps/vision.ts:174-302`

The script version (`scripts/extract-foreground-masks.ts`) extracts both character/foreground polygons AND speech bubble polygons from segmentation data. The workflow only extracts foreground character polygons.

**Impact:** Bubble polygons are used for the layered panel rendering (SVG clip-paths). Without them, bubbles may render incorrectly in the layered view on workflow-ingested issues.

**Fix:** Add `"speech bubble"` to the `FOREGROUND_CLASSES` set, or extract bubble polygons separately and store them on the `bubbles` table. Need to check if the `bubbles` table has a polygon column.

### 7. Missing pipeline steps — wiki context fetch (LOW-MEDIUM)

The script pipeline has `fetch-wiki-context` which fetches MediaWiki page content for the issue and caches it. This wiki content is injected into every Gemini prompt during `getContextPage`, helping with character identification.

The workflow has no equivalent. The `issues` table has a `wiki_url` column but no step fetches and caches the content.

**Options:**
- A) Add a `fetchWikiContext` step to the workflow that downloads and stores wiki text in the `issues` table (e.g., `wiki_content` column)
- B) Fetch wiki content inline during `getContextPage` (simpler but re-fetches per page)
- C) Skip for now — the improved prompt + exemplar matching may be sufficient

**Recommendation:** Option A eventually, but low priority. The character lookahead + exemplar embeddings already provide strong character identification context.

### 8. Missing `voice-rotation-archive` step (LOW)

After audio generation, the script archives IVC voices back to cold storage to free up ElevenLabs slots. The workflow has `voiceRotationCheckout` (restore) but no archive step after generation completes.

**Impact:** ElevenLabs voice slots may fill up if not archived. Only affects IVC voices.

**Fix:** Add a `voiceRotationArchive` step after `generateAudioBatch` that mirrors the archive logic from `scripts/voice-rotation.ts`.

---

## Equivalent / intentional differences (no action needed)

| Step | Notes |
|---|---|
| `roboflowAnalyzeBatch` | Cloud adaptation (Supabase Storage URLs vs local files). Logic equivalent. |
| `sortPageElements` | Roughly equivalent. Both use Gemini vision for reading order. |
| `consolidateMusicScenes` | Equivalent. |
| `generateManifest` | Equivalent (cloud adaptation). |
| `addBubbleStyles` | Minor field access difference — may need verification that `box_2d` JSON column is read correctly. |
