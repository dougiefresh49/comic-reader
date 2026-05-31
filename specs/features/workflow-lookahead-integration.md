# Feature: Unify Character Lookahead — Script → Workflow + Exemplar Embeddings

## Status: `pending`

## Prerequisite: Face exemplar embeddings (done — pgvector + `gemini-embedding-2` infrastructure in place, 27 exemplars seeded from issue-1)

## Priority: High — the workflow version is the production path; without this, new books ingested via the Vercel Workflow pipeline don't benefit from clustering or exemplar matching

---

## Problem

There are **two implementations** of character lookahead that diverged:

| | Script (`scripts/character-lookahead.ts`) | Workflow (`src/workflows/steps/vision.ts`) |
|---|---|---|
| **Created** | May 2 (PR #28) — 3 iterations | May 5 (PR #36) — written from scratch |
| **Clustering** | Yes — groups faces by name across pages, tracks best exemplar per cluster | No — each face identified in isolation |
| **Cross-page context** | Yes — clusters grow as pages are processed | No — each page is independent |
| **Exemplar embeddings** | Yes — pgvector similarity search before ID, stores after confirmed ID | No |
| **Face extraction** | Uses `face-extraction.ts` (dedup, IoU, panel-local coords, JPEG+WebP buffers) | Inline — basic bbox from segmentation, no dedup, no JPEG buffer |
| **Identification** | Uses `face-matcher.ts` (structured prompt, exemplar references, reasoning field) | Inline — minimal prompt, no exemplar support |
| **Alias resolution** | Uses `resolveCharacterId()` — checks DB aliases | Direct `toLowerCase().replace()` — no alias lookup |
| **Confidence threshold** | 0.6 for detection, 0.7 for exemplar storage, 0.9 for auto-confirm | 0.6 for detection |
| **Rate limiting** | Concurrent via `Promise.all` per page | Sequential with 1s delay per face |

**The workflow version is the production path** (triggered from admin UI, runs via Vercel Workflows). The script version has all the real logic but is only used for local/manual runs.

### What the workflow version does right

The workflow version has one advantage: it reads data entirely from Supabase (Storage + DB) rather than the local filesystem. This is correct for the cloud pipeline. It also:

- Creates a Supabase client per step via `createStepClient()` (required by `"use step"` directive)
- Downloads page images from `comic-pages` Storage bucket
- Reads segmentation data from `page_segmentation` table (not local SAM3 JSON files)
- Reads known characters from the `characters` table (not local roster file)
- Uses `character_id` derived from the `characters` table query, not a local roster

These patterns must be preserved — the workflow cannot touch the local filesystem.

---

## Solution

Extract the shared identification logic into reusable functions that work with Supabase (no filesystem), then use them from both the workflow step and the script. The workflow step gains clustering, exemplar matching, and better prompts. The script continues to work for local runs.

---

## Architecture

### Shared module: `src/lib/character-identification.ts`

A new **shared module** (importable from both `scripts/` and `src/workflows/`) containing the core identification logic:

```
src/lib/character-identification.ts
├── identifyFace(gemini, faceCrop, knownCharacters, exemplars?)
├── matchFaceToClusters(gemini, faceCrop, clusters, knownCharacters)
├── resolveCharacterId(supabase, name)
├── buildKnownCharacterList(supabase, bookId)
└── types: CharacterCluster, ExemplarReference, FaceCrop
```

This is essentially `scripts/utils/face-matcher.ts` + `scripts/utils/exemplar-store.ts` refactored to:
1. Accept a Supabase client as a parameter (instead of importing the singleton)
2. Work with `Buffer` inputs (no filesystem paths)
3. Export clean TypeScript types

### Shared module: `src/lib/embeddings.ts`

Move `scripts/utils/embeddings.ts` → `src/lib/embeddings.ts` (or keep both with one re-exporting the other). The embedding functions are pure — they just call the Gemini API, no filesystem or Supabase dependency.

### Workflow step: updated `characterLookaheadPage`

The workflow step gets rewritten to use the shared module. Key changes:

1. **Use shared face extraction logic** — deduplication, padding, IoU filtering, JPEG buffer generation
2. **Use shared identification** — structured prompts from `face-matcher.ts`, exemplar references
3. **Exemplar retrieval before identification** — query pgvector for similar confirmed exemplars
4. **Exemplar storage after confirmed identification** — embed + store high-confidence faces
5. **Alias-aware character resolution** — use `resolveCharacterId` instead of naive string manipulation

### Workflow orchestration: cross-page clustering

The current workflow calls `characterLookaheadPage()` once per page independently:

```typescript
for (const page of pages) {
  await characterLookaheadPage(bookId, issueId, page.pageNumber);
}
```

To support cross-page clustering, two approaches:

**Option A: Rely on exemplar store (recommended)**
Each page's step queries the exemplar store, which grows as pages are processed. Page 1 has no exemplars. Page 2 benefits from page 1's stored exemplars. Page 10 benefits from pages 1-9. This gives us cross-page context without needing to pass cluster state between steps.

The `"use step"` boundary means each page runs as an independent, retryable unit — which is a feature of durable workflows. Cross-page mutable state (like the script's `clusters[]` array) would break retry semantics. The exemplar store in pgvector is the durable equivalent.

**Option B: Single step for all pages**
Run all pages in one `"use step"` block with an in-memory cluster array. Simpler but loses per-page retry granularity and risks timeout on large issues.

**Recommendation: Option A.** The exemplar store is specifically designed for this — it's the durable, persistent version of the in-memory cluster array.

---

## Detailed Changes

### Step 1: Create shared module `src/lib/character-identification.ts`

Extract and adapt from `scripts/utils/face-matcher.ts`:

```typescript
import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FaceIdentification {
  characterName: string | null;
  confidence: number;
  reasoning?: string;
}

export interface ExemplarReference {
  characterName: string;
  jpegBase64: string;
  confidence: number;
}

export async function identifyFace(
  gemini: GoogleGenAI,
  model: string,
  faceImageBase64: string,
  faceImageMimeType: string,
  knownCharacters: string[],
  exemplars?: ExemplarReference[],
): Promise<FaceIdentification>

export async function resolveCharacterId(
  supabase: SupabaseClient,
  name: string,
): Promise<string | null>

export async function buildKnownCharacterList(
  supabase: SupabaseClient,
  bookId: string,
): Promise<string[]>
```

Key difference from the script version: no `FaceCrop` type dependency — accepts raw base64 + mime type. This keeps it framework-agnostic.

### Step 2: Create shared module `src/lib/exemplar-store.ts`

Extract and adapt from `scripts/utils/exemplar-store.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export async function findSimilarExemplars(
  supabase: SupabaseClient,
  jpegBase64: string,
  bookIds: string[],
  limit?: number,
): Promise<ExemplarMatch[]>

export async function storeExemplar(
  supabase: SupabaseClient,
  params: StoreExemplarParams,
): Promise<string>

export async function downloadExemplarImage(
  supabase: SupabaseClient,
  cropPath: string,
): Promise<Buffer | null>
```

Key difference: accepts `supabase` as a parameter instead of importing the singleton. This is required because workflow steps use `createStepClient()`.

### Step 3: Move `src/lib/embeddings.ts`

Move `scripts/utils/embeddings.ts` → `src/lib/embeddings.ts`. Pure functions, no changes needed. Update import paths in `scripts/utils/exemplar-store.ts` to re-export or alias.

### Step 4: Rewrite `characterLookaheadPage` in `src/workflows/steps/vision.ts`

Replace the current ~220 lines (304-523) with:

```typescript
export async function characterLookaheadPage(
  bookId: string,
  issueId: string,
  pageNumber: number,
) {
  "use step";
  const { createStepClient } = await import("../step-utils");
  const supabase = await createStepClient();

  // ... (download page image, get segmentation, extract face crops — 
  //      use shared face extraction logic with dedup + JPEG buffers)

  const knownCharacters = await buildKnownCharacterList(supabase, bookId);

  for (const face of faceCrops) {
    // 1. Retrieve similar exemplars from pgvector
    const exemplarMatches = await findSimilarExemplars(
      supabase, face.jpegBase64, [bookId], 3
    );
    const exemplarRefs = await Promise.all(
      exemplarMatches.map(async (m) => {
        const img = await downloadExemplarImage(supabase, m.cropPath);
        return img ? { characterName: m.characterId, jpegBase64: img.toString("base64"), confidence: m.confidence } : null;
      })
    ).then(refs => refs.filter(Boolean));

    // 2. Identify with exemplar context
    const result = await identifyFace(
      gemini, GEMINI_MEDIUM, face.jpegBase64, "image/jpeg",
      knownCharacters, exemplarRefs
    );

    // 3. Resolve character ID via alias lookup
    if (result.characterName && result.confidence >= 0.6) {
      const charId = await resolveCharacterId(supabase, result.characterName);
      // ... insert detection row

      // 4. Store high-confidence face as new exemplar
      if (result.confidence >= 0.7 && charId) {
        await storeExemplar(supabase, {
          jpegBuffer: face.jpegBuffer,
          characterId: charId,
          bookId, sourceIssue: issueId,
          pageNumber, confidence: result.confidence,
          isConfirmed: result.confidence >= 0.9,
        });
      }
    }
  }
}
```

### Step 5: Update `scripts/character-lookahead.ts`

Update imports to use the shared modules from `src/lib/`. The script version continues to work as before but uses the same identification logic. The script-specific parts (CLI arg parsing, filesystem SAM3 JSON reading, results.json caching) remain in the script.

### Step 6: Update `scripts/utils/face-matcher.ts` and `scripts/utils/exemplar-store.ts`

These become thin wrappers that re-export from `src/lib/` with the singleton Supabase client pre-bound:

```typescript
// scripts/utils/face-matcher.ts
import { identifyFace as _identifyFace } from "../../src/lib/character-identification";
import { supabase } from "../lib/supabase";

export async function identifySingleFace(gemini, face, knownCharacters, exemplars?) {
  return _identifyFace(gemini, GEMINI_MEDIUM, face.imageBuffer.toString("base64"), "image/webp", knownCharacters, exemplars);
}
```

---

## Face extraction in the workflow

The workflow currently does inline face extraction (lines 405-441 of `vision.ts`). The script uses `scripts/utils/face-extraction.ts` which has:

- **Deduplication** — IoU-based merging when face/head detections overlap (prefers "face" class over "head")
- **Min crop size** — skips faces smaller than 20px
- **Panel-local coordinates** — computes `bboxPanelLocal` for the detection record
- **JPEG buffer** — produces both WebP and JPEG via `sharp.clone()`

The workflow's inline version lacks all of these. The shared module should include a `extractFaceCrops` function that:
1. Takes segmentation predictions + image buffer + panel list
2. Returns deduplicated face crops with both WebP and JPEG buffers
3. Works in-memory (no filesystem)

This can be extracted from `scripts/utils/face-extraction.ts` with the filesystem parts (glob, fs.readFile) removed — the caller provides the image buffer and predictions.

---

## What to keep from the workflow version

- **`createStepClient()` pattern** — each step creates its own Supabase client (required by `"use step"`)
- **Storage-based image access** — download from `comic-pages` bucket, not local filesystem
- **`page_segmentation` table access** — read predictions from DB, not local SAM3 JSON files
- **DB-based character list** — query `characters` table, not local roster file
- **Sequential processing with delays** — `await new Promise(r => setTimeout(r, 1000))` between faces to avoid Gemini rate limits. The script uses `Promise.all` which works locally but would hit rate limits in production

---

## What to keep from the script version

- **Face deduplication** — IoU-based merging, critical for avoiding duplicate detections
- **JPEG buffer generation** — required for `gemini-embedding-2` (no WebP support)
- **Structured prompts** — the script's `buildIdentifyPrompt` and `buildComparisonPrompt` are more thorough than the workflow's inline prompt
- **Exemplar retrieval + storage** — the core of the face exemplar embeddings feature
- **Alias-aware character resolution** — `resolveCharacterId` checks DB aliases, not just naive string conversion
- **Confidence tiering** — 0.6 for detection, 0.7 for exemplar storage, 0.9 for auto-confirm

---

## Implementation Plan

### Step 1: Shared modules (~2 hours)
- [ ] `src/lib/character-identification.ts` — extract from `face-matcher.ts`
- [ ] `src/lib/exemplar-store.ts` — extract from `scripts/utils/exemplar-store.ts`
- [ ] `src/lib/embeddings.ts` — move from `scripts/utils/embeddings.ts`
- [ ] `src/lib/face-extraction.ts` — extract in-memory face crop logic from `scripts/utils/face-extraction.ts`

### Step 2: Workflow integration (~2 hours)
- [ ] Rewrite `characterLookaheadPage` in `vision.ts` to use shared modules
- [ ] Add rate-limiting delay between faces (keep sequential for cloud)
- [ ] Test with workflow dev server

### Step 3: Script migration (~1 hour)
- [ ] Update `scripts/utils/face-matcher.ts` to delegate to shared module
- [ ] Update `scripts/utils/exemplar-store.ts` to delegate to shared module
- [ ] Update `scripts/character-lookahead.ts` imports
- [ ] Verify script still works: `pnpm character-lookahead -- --book tmnt-mmpr-iii --issue issue-1 --overwrite`

### Step 4: Typecheck + test (~30 min)
- [ ] `pnpm typecheck`
- [ ] Run seed on issue-1 to verify exemplar flow works end-to-end
- [ ] Trigger workflow on a test issue via admin UI

**Total estimate: ~5-6 hours**

---

## Open Questions

1. **Workflow sandbox compatibility** — The `"use step"` directive gives full Node.js access, so `sharp`, `@google/genai`, and `@supabase/supabase-js` should all work. But need to verify sharp runs in the Vercel Functions environment (it has native bindings).
2. **Rate limiting strategy** — Use `GEMINI_API_KEY` as primary, failover to `GEMINI_API_KEY_2` on 429 responses. Both keys are available in `.env`. Implement a simple retry-with-fallback: on rate limit, switch to the backup key and retry. Additionally, use `p-limit(3)` for bounded concurrency with automatic backpressure (faster than 1s sequential, safer than unbounded `Promise.all`).
3. **Exemplar store cold start** — First issue in a new franchise has no exemplars. Two fallback strategies:
   - **Wiki seeding**: If `character-roster.json` includes wiki URLs or image references, download character reference images and seed them as low-confidence exemplars before page processing begins.
   - **Name + image + Gemini confirmation**: For characters with no exemplars, use the character name + face crop + a Gemini "is this [name]?" confirmation query as a worst-case bootstrap. If confirmed at ≥0.7, store as an exemplar for subsequent pages.
   Either approach gives pages 2+ something to work with even on a brand-new franchise.
4. **Import path compatibility** — `scripts/` uses `.js` extensions and `tsconfig` with `moduleResolution: "node16"`. `src/` uses Next.js `~` aliases. The shared modules in `src/lib/` need to be importable from both. May need `tsconfig` path adjustment or a shared package.
