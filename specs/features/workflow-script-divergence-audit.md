# Workflow vs Script Pipeline: Divergence Audit

## Status: `done`

Audit date: 2026-05-06 | All items resolved: 2026-05-07

Compared every workflow step in `src/workflows/steps/` against its script counterpart in `scripts/`. All divergences have been resolved.

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

## Resolved in follow-up (2026-05-07)

### 4. `getContextPage` — wiki context now injected into Gemini prompts

**Was:** Book context only included book name + franchises. No wiki data.

**Now:** `getContextPage` loads `wiki_summary` and `wiki_appearances` from the `issues` table and injects them into the prompt as "Issue Synopsis" and "Known Characters in this issue". This provides the full character list and plot context that was previously only available in the script pipeline.

**Files changed:** `src/workflows/steps/vision.ts`

### 5. `getCharactersNeedingVoices` — IVC characters excluded from Voice Design

**Was:** All characters without a `voice_id` were sent through Voice Design generation, including IVC characters that should have been set up manually during casting.

**Now:** Queries the `castlist` table and excludes characters with a `voice_uuid` (IVC characters whose voice was assigned during the casting pause point). Only characters that genuinely need Voice Design proceed to auto-generation.

**Files changed:** `src/workflows/steps/generation.ts`

### 6. `extractForegroundMasksBatch` — bubble polygons now extracted

**Was:** Only character/foreground polygons were extracted from SAM3 segmentation data. Speech bubble polygons were completely absent.

**Now:** Extracts both character and speech bubble polygons into the structured `{ characters: [...], bubbles: [...] }` format matching the `PanelForegroundPolygons` type used by the frontend's layered panel renderer.

**Files changed:** `src/workflows/steps/vision.ts`

### 7. Wiki context fetch step added to pipeline

**Was:** No wiki fetch step existed in the workflow. Character identification and context prompts had no wiki data.

**Now:** `fetchWikiContextStep` in `src/workflows/steps/wiki.ts` fetches MediaWiki content (synopsis + character appearances) via the shared `src/lib/wiki-fetch.ts` module and persists to the `issues` table. Runs after foreground mask extraction, before character lookahead. The script `scripts/fetch-wiki-context.ts` now delegates to the same shared module.

**Files changed:** `src/lib/wiki-fetch.ts` (new), `src/workflows/steps/wiki.ts` (new), `src/workflows/ingest-pipeline.ts`, `scripts/fetch-wiki-context.ts`

### 8. Voice rotation checkout — intentionally excluded

**Was:** `voiceRotationCheckout` was called automatically in the pipeline.

**Decision:** Removed from the automated pipeline per user direction. IVC archive/restore is managed manually via the admin dashboard to prevent IVC voices from having to be re-done for follow-up issues in the same series. The admin dashboard's casting UI handles voice rotation when needed.

---

## Equivalent / intentional differences (no action needed)

| Step | Notes |
|---|---|
| `roboflowAnalyzeBatch` | Cloud adaptation (Supabase Storage URLs vs local files). Logic equivalent. |
| `sortPageElements` | Roughly equivalent. Both use Gemini vision for reading order. |
| `consolidateMusicScenes` | Equivalent. |
| `generateManifest` | Equivalent (cloud adaptation). |
| `addBubbleStyles` | Minor field access difference — may need verification that `box_2d` JSON column is read correctly. |
