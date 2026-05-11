# Feature: Face Exemplar Embeddings (pgvector + gemini-embedding-2)

## Status: `pending`

## Prerequisite: Character lookahead pipeline (done), `character_face_exemplars` migration (done)

## Priority: Medium — improves identification accuracy on edge cases; current pipeline works for major characters

---

## Problem

The character lookahead pipeline identifies faces by sending each face crop to Gemini Flash with a flat text list of known character names. Gemini has **no visual reference** for what each character looks like in this specific art style. It works well for distinctive characters (Leonardo's blue mask, Krang's brain-body) but fails on:

- Characters in alternate costumes (helmetless Rangers)
- Characters who appear differently across art styles
- Minor/side characters not in the roster
- Generic faces (soldiers, civilians) that could match multiple characters

**Result:** ~60 out of 87 face clusters in issue-1 went unidentified.

## Solution

Use `gemini-embedding-2` to generate multimodal embeddings of confirmed face crops, store them in Supabase pgvector, and retrieve visually similar exemplars when identifying new faces. Gemini then sees "here's the unknown face, and here are 3 confirmed Leonardo faces from earlier pages" — a much stronger signal than name-only.

**Key insight:** `gemini-embedding-2` places text and images in the same vector space, enabling cross-modal similarity (text descriptions ↔ face images).

---

## Research

See [specs/research/gemini-file-search-evaluation.md](../research/gemini-file-search-evaluation.md) for the full evaluation of Gemini File Search Store vs self-hosted pgvector. Also evaluated [contextdb](https://github.com/antiartificial/contextdb) as a scoring layer.

**Decision:** Self-hosted pgvector over Google's File Search Store for data ownership and vendor flexibility. Borrow contextdb's confidence-weighted scoring idea as a lightweight SQL formula.

---

## Architecture

### Data flow — storing exemplars

```
Face crop identified (high confidence or human-verified)
  → sharp: convert WebP crop to JPEG buffer
  → Supabase Storage: upload to `face-exemplars` bucket
  → gemini-embedding-2: embedContent(jpeg_bytes) → 768-dim vector
  → Supabase DB: INSERT into character_face_exemplars (crop_path, embedding, character_id, confidence, ...)
```

### Data flow — retrieving exemplars at identification time

```
Unknown face crop (WebP buffer)
  → sharp: convert to JPEG buffer
  → gemini-embedding-2: embedContent(jpeg_bytes) → 768-dim vector
  → pgvector: similarity search with confidence weighting
  → top 3–5 exemplar matches returned (character_id, crop image, confidence)
  → pass exemplar images + names as context to Gemini Flash identification call
  → improved identification with visual references
```

### Confidence-weighted scoring

Inspired by [contextdb](https://github.com/antiartificial/contextdb)'s composite scoring. Rather than pure cosine similarity, weight by identification confidence:

```sql
SELECT
  id, character_id, crop_path, confidence,
  (1 - (embedding <=> $1)) AS similarity,
  (1 - (embedding <=> $1)) * 0.7 + confidence * 0.3 AS composite_score
FROM character_face_exemplars
WHERE is_confirmed = true
  AND book_id = ANY($2)  -- same franchise books
ORDER BY composite_score DESC
LIMIT 5;
```

This prefers exemplars that are both visually similar AND were identified with high confidence.

---

## Schema Changes

### Migration: add pgvector extension + embedding column

```sql
-- Enable pgvector (may already be enabled in Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to existing table
ALTER TABLE character_face_exemplars
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for fast similarity search (only on confirmed exemplars)
CREATE INDEX face_exemplars_embedding_idx
  ON character_face_exemplars
  USING hnsw (embedding vector_cosine_ops)
  WHERE is_confirmed = true;
```

The `character_face_exemplars` table already exists (migration `20260505000000`). This migration adds the vector column to it.

### Supabase Storage

Create a `face-exemplars` bucket (public read, service_role write). Face crops stored as JPEG at path: `{book_id}/{issue_id}/{character_id}/{exemplar_id}.jpg`

---

## New Files

### `scripts/utils/embeddings.ts`

Embedding utility adapted from the [`appraisal-comps-map`](https://github.com/dougiefresh49/appraisal-comps-map/blob/main/src/lib/embeddings.ts) pattern:

```typescript
import { GoogleGenAI, createPartFromBase64 } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 768;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export async function embedImage(
  imageBase64: string,
  mimeType = "image/jpeg",
): Promise<number[]> {
  const result = await getClient().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [createPartFromBase64(imageBase64, mimeType)],
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  return result.embeddings?.[0]?.values ?? [];
}

export async function embedText(text: string): Promise<number[]> {
  if (!text.trim()) return new Array(EMBEDDING_DIMENSIONS).fill(0);
  const result = await getClient().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  return result.embeddings?.[0]?.values ?? [];
}
```

### `scripts/utils/exemplar-store.ts`

Supabase pgvector operations for storing and retrieving exemplars:

- `storeExemplar(crop: Buffer, characterId: string, metadata: {...})` — convert to JPEG, upload to Storage, embed, insert row
- `findSimilarExemplars(cropBuffer: Buffer, bookIds: string[], limit?: number)` — embed crop, run composite-scored similarity query, return matches with crop URLs
- `seedFromExistingClusters(clusters: CharacterCluster[])` — bulk-import high-confidence clusters from a previous run

---

## Modified Files

### `scripts/utils/face-matcher.ts`

**`identifySingleFace()`** — add optional `exemplars` parameter. When provided, include exemplar face images in the Gemini prompt as visual references:

```
Current prompt:
  "Identify this character" + [unknown face] + text list of names

Enhanced prompt:
  "Identify this character" + [unknown face] + "Here are confirmed examples:"
  + [exemplar 1: Leonardo] + [exemplar 2: Leonardo] + [exemplar 3: Raphael] + ...
  + text list of names
```

**`matchFaceToClusters()`** — optionally augment cluster exemplars with stored pgvector exemplars for richer comparison.

### `scripts/character-lookahead.ts`

1. **Before identification loop** — call `findSimilarExemplars()` for each face crop to retrieve visual references
2. **After confirmed identification** — call `storeExemplar()` to grow the exemplar store
3. **New `--seed` flag** — one-time import of existing high-confidence clusters into the exemplar store

### `scripts/utils/face-extraction.ts`

**`extractCropsFromSidecar()`** — in addition to the WebP buffer, also produce a JPEG buffer for embedding. The WebP crop is already generated via sharp; add `.jpeg()` output alongside it. Store as `jpegBuffer` on `FaceCrop`.

---

## WebP → JPEG conversion

`gemini-embedding-2` does not support WebP. Face crops are currently extracted as WebP (matching the page format). Two options:

**Option A (preferred):** Add a `jpegBuffer` field to `FaceCrop` — extract produces both formats. WebP for display, JPEG for embedding/storage.

**Option B:** Convert on-demand in `embedImage()` via sharp. Simpler but adds latency per embedding call.

Go with Option A — one sharp call vs. N.

---

## Embedding dimensions

`gemini-embedding-2` supports 128–3,072 dimensions. Tradeoffs:

| Dimensions | pgvector storage | Index size | Quality |
|------------|-----------------|------------|---------|
| 768 | ~3 KB/row | Small | Good — matches `gemini-embedding-001` default |
| 1,536 | ~6 KB/row | Medium | Better |
| 3,072 | ~12 KB/row | Large | Best |

**Start with 768.** Our exemplar count is small (hundreds, not millions). If quality is insufficient, bump to 1,536 — the migration is just re-embedding and updating the column width.

---

## Implementation Plan

### Step 1: Infrastructure (~1 hour)
- [ ] Migration: enable pgvector, add `embedding vector(768)` column + HNSW index
- [ ] Create `face-exemplars` Supabase Storage bucket
- [ ] `scripts/utils/embeddings.ts` — embedding utility

### Step 2: Store & retrieve (~2 hours)
- [ ] `scripts/utils/exemplar-store.ts` — store/query functions
- [ ] `scripts/utils/face-extraction.ts` — add `jpegBuffer` to `FaceCrop`
- [ ] Test: embed a known face crop, store it, retrieve by similarity

### Step 3: Integrate into lookahead (~2 hours)
- [ ] `scripts/utils/face-matcher.ts` — add exemplar images to identification prompt
- [ ] `scripts/character-lookahead.ts` — retrieve before ID, store after confirmed ID
- [ ] `--seed` flag to import existing clusters

### Step 4: Validate (~1 hour)
- [ ] Seed store with ~27 high-confidence clusters from issue-1
- [ ] Re-run identification on ~60 unidentified clusters
- [ ] Measure: how many now get correctly identified?
- [ ] Tune: composite score weights, embedding dimensions, exemplar count per query

**Total estimate: ~6 hours**

---

## Open Questions

1. **Embedding quality on comic art** — `gemini-embedding-2` is trained on real-world images. Do stylized comic art face crops produce useful embeddings? Needs testing.
2. **Optimal exemplar count per character** — 1 exemplar? 3? 5? More exemplars = better coverage of costumes/angles, but diminishing returns.
3. **Cross-franchise contamination** — should the similarity query filter by franchise, or can cross-franchise exemplars help? (e.g., Leonardo in TMNT × MMPR vs TMNT Saturday Morning Adventures)
4. **When to auto-confirm** — what confidence threshold triggers automatic exemplar storage vs requiring human review?

---

## Future: Phase 2 (cross-modal knowledge base)

Once Phase 1 validates the approach, extend to:
- Embed text descriptions (wiki summaries, voice notes) in the same vector space
- Cross-modal queries: text → image and image → text
- Use at voice-description and casting stages
- Accumulated knowledge benefits new books in the same franchise automatically
