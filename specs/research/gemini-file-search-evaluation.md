# Gemini Embedding 2 — Evaluation for Character Lookahead

**Date:** 2026-05-06
**Context:** Google released `gemini-embedding-2` with multimodal embedding support (text + images in the same vector space) and a managed File Search tool. Evaluating how this improves the character lookahead pipeline, with a focus on self-hosted pgvector storage to avoid vendor lock-in.

---

## What gemini-embedding-2 Offers

### Embedding model (what we'd use)

`gemini-embedding-2` generates embeddings from **both text and images** into the same vector space:

- **Dimensions:** 3,072 default, configurable down to 128 (recommended: 768, 1,536, or 3,072)
- **Image formats:** PNG, JPEG (no WebP)
- **Max 6 images per embedding request**
- **Cross-modal:** text and image embeddings are comparable via cosine similarity
- **API:** same `@google/genai` SDK we already use — `embedContent()` with image bytes instead of text
- **Pricing:** free for query-time embeddings

```typescript
import { GoogleGenAI, createPartFromBase64 } from "@google/genai";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Text embedding (same as gemini-embedding-001 pattern)
const textResult = await client.models.embedContent({
  model: "gemini-embedding-2",
  contents: "Leonardo, blue bandana, twin katanas",
  config: { outputDimensionality: 768 },
});

// Image embedding (new — face crop)
const imageResult = await client.models.embedContent({
  model: "gemini-embedding-2",
  contents: [createPartFromBase64(faceCropBase64, "image/jpeg")],
  config: { outputDimensionality: 768 },
});
```

### File Search Store (evaluated and rejected)

Google also offers a managed File Search Store that handles chunking, indexing, and retrieval as a hosted service. We evaluated this but **prefer self-hosted pgvector** to avoid vendor lock-in. See "Architecture Decision" below.

---

## Current Character Lookahead Pipeline

The character lookahead (`scripts/character-lookahead.ts`) is fundamentally a **vision task**:

1. **Extract face crops** — SAM3 segmentation polygons → crop face regions from page WebP images
2. **Identify each face** — Send face crop (base64 image) to Gemini Flash with a text list of known characters → returns `{ character_name, confidence }`
3. **Cluster incrementally** — Group by name, store highest-confidence exemplar per cluster
4. **Persist** — Write to `panel_character_detections` table, assign bubbles to nearest character

The known-character list is built from two sources:
- `character-roster.json` (canonical names, aliases, first appearance)
- `issues.wiki_appearances` (scraped from MediaWiki)

**Current weakness:** Gemini identifies each face in isolation with only a text list of names. It has no visual reference for what "Leonardo" looks like in this specific art style. This directly causes the ~60 unidentified clusters from issue-1.

---

## Architecture Decision: Self-Hosted pgvector

### Why pgvector over Google File Search Store

| Concern | Google File Search Store | Self-hosted pgvector |
|---------|------------------------|---------------------|
| Data ownership | Google-managed, opaque | Our Supabase DB, full control |
| Vendor lock-in | Tied to Gemini ecosystem | Embedding model is swappable |
| Storage | Google's servers | Supabase Storage + pgvector column |
| Querying | Opaque retrieval via tool | Custom SQL — joins, filters, confidence weighting |
| Cost | Free storage, $0.15/1M token indexing | Already paying for Supabase |
| Migration path | Rebuild from scratch | Change embedding model, re-embed, same infra |
| Existing experience | None | Prior project (`appraisal-comps-map`) used pgvector with `gemini-embedding-001` |

**Decision:** Use `gemini-embedding-2` for embedding generation only. Store vectors in our existing Supabase pgvector. This gives us the best embedding model with full data ownership.

### Prior art

The `appraisal-comps-map` project used this exact pattern:
- `@google/genai` SDK → `embedContent()` → 768-dim vectors
- Stored in Supabase pgvector column
- Similarity search via SQL `<=>` operator (cosine distance)

The new version just swaps `gemini-embedding-001` → `gemini-embedding-2` and adds image inputs.

### ContextDB evaluation (explored and deferred)

[github.com/antiartificial/contextdb](https://github.com/antiartificial/contextdb) — a Go-based temporal graph-vector DB that layers epistemic scoring on top of pgvector. Its composite scoring formula:

```
score = w_sim * cosine(q, v) + w_conf * confidence + w_rec * exp(-alpha * age) + w_util * utility
```

Factors in source confidence, recency decay, and utility beyond raw cosine similarity. Interesting for AI agent memory systems, but **overkill for face matching.** The credibility tracking, belief reconciliation, and bi-temporal versioning solve problems we don't have yet.

**Worth borrowing:** The confidence-weighted scoring idea. We can implement a lightweight version directly in our pgvector query:

```sql
SELECT *,
  (1 - (embedding <=> query_embedding)) * 0.7 + confidence * 0.3 AS composite_score
FROM character_face_exemplars
WHERE book_id = $1 AND is_confirmed = true
ORDER BY composite_score DESC
LIMIT 5;
```

**Revisit if:** We later need multi-source credibility tracking (e.g., "this Roboflow model version is more trustworthy than that one") or cross-agent memory with provenance chains.

---

## Recommended Approach

### Phase 1: Face exemplar store with pgvector (~4-6 hours)

Build a face exemplar store that grows as characters are identified:

1. **Enable pgvector** in Supabase (if not already)
2. **Add embedding column** to `character_face_exemplars` table (768-dim vector)
3. **On confirmed identification** — crop face as JPEG, embed via `gemini-embedding-2`, store crop path + embedding + metadata in DB, upload crop to Supabase Storage
4. **At identification time** — embed unknown face crop → pgvector similarity search → retrieve top-N matching exemplars → pass those face images as context to the Gemini identification call

**Data flow:**
```
Unknown face crop (JPEG)
  → gemini-embedding-2 → 768-dim vector
  → pgvector similarity search (cosine, confidence-weighted)
  → top 3-5 exemplar matches
  → pass exemplar images + names to Gemini Flash identification call
  → "this face matches Leonardo (exemplar similarity: 0.92)"
```

**Changes:**
- `supabase/migrations/` — add `embedding vector(768)` column to `character_face_exemplars`, create HNSW index
- `scripts/utils/embeddings.ts` — new file, adapted from `appraisal-comps-map` pattern but with image support
- `scripts/character-lookahead.ts` — after confirmed ID, embed + store exemplar; before ID, retrieve similar exemplars
- `scripts/utils/face-matcher.ts` — add pgvector similarity search function

**DB schema addition:**
```sql
-- Add to existing character_face_exemplars table
ALTER TABLE character_face_exemplars
  ADD COLUMN embedding vector(768);

CREATE INDEX face_exemplars_embedding_idx
  ON character_face_exemplars
  USING hnsw (embedding vector_cosine_ops)
  WHERE is_confirmed = true;
```

### Phase 2: Full multimodal knowledge base (~1-2 days)

Everything in Phase 1, plus:
- Embed character text descriptions (wiki summaries, roster data, voice descriptions) into the same vector space
- Cross-modal queries: "find characters that match this face AND this description"
- Use at voice-description and casting stages too
- New books in the same franchise auto-benefit from accumulated exemplars

### Phase 3: Skip for now (Zero effort)

Wait and see. The current pipeline works for major characters.

---

## Key Questions to Validate

1. Does `gemini-embedding-2` produce good embeddings for **comic art face crops**? (stylized, not photorealistic)
2. How many exemplars per character are needed for reliable matching? (1? 3? 5?)
3. What embedding dimensionality balances quality vs. storage? (768 vs 1,536)
4. Does cross-modal search work well? (text query "blue bandana turtle" → Leonardo face crops)

**Test plan:** Seed the store with the ~27 high-confidence identified clusters from issue-1. Re-run identification on the ~60 unidentified clusters with exemplar retrieval and measure improvement.

---

## SDK Compatibility

Uses the same `@google/genai` SDK we already import. The embeddings utility would look like:

```typescript
import { GoogleGenAI, createPartFromBase64 } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-2";
const EMBEDDING_DIMENSIONS = 768;

export async function embedImage(imageBase64: string, mimeType = "image/jpeg"): Promise<number[]> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [createPartFromBase64(imageBase64, mimeType)],
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  return result.embeddings?.[0]?.values ?? [];
}

export async function embedText(text: string): Promise<number[]> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const result = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });
  return result.embeddings?.[0]?.values ?? [];
}
```

No new dependencies required.

---

## Key Limitations

- **No WebP for embeddings** — must convert face crops to JPEG/PNG before embedding (source JPEGs available in `pages/`)
- **Max 6 images per embedding request** — batch accordingly
- **Embedding is one-way** — you can't reconstruct the image from the vector
- **pgvector HNSW index** — needs tuning for recall vs. speed at scale (fine for our volume)
- **Cross-modal quality unknown** — text↔image similarity needs testing with our specific content
