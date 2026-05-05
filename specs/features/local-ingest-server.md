# Feature: Ingest Pipeline — Cloud Workflow

## Status: `in-progress`

---

## Purpose

Run the comic ingest pipeline with maximum automation, controllable entirely from the admin dashboard (phone or browser). Human review steps pause the workflow and resume when the browser review UI is completed. Progress is tracked in Supabase so the admin dashboard shows live pipeline state.

---

## Architecture: Vercel Workflows

All pipeline steps run as durable Vercel Workflow steps with automatic retry and zero-cost suspension during human review pauses. No local worker needed for production use.

**Key properties:**
- No max run duration — workflow can suspend for days during human review
- Each step retries independently on failure
- 50K steps/month free on Hobby tier
- `defineHook()` for human pause/resume — zero compute while waiting
- 300s max per individual function (sufficient for all steps)

---

## Pipeline Steps — Full Breakdown

### Pre-pipeline (runs during page download)

These run inline during the Browserbase page download (`/api/admin/download-pages`):

| Former step | How it moves | Notes |
|---|---|---|
| `validate-inputs` | Validated during download (page count > 0) | — |
| `generate-pages-metadata` | `sharp(buffer).metadata()` extracts dimensions per page | Write to `pages` table or `pages.json` in storage |
| `convert-pages-to-webp` | `sharp(buffer).webp({ quality: 82 })` converts inline | Upload JPEG to `comic-pages-raw` AND WebP to `comic-pages` in parallel via `Promise.all` |

No separate pipeline steps needed — this data is available the moment the download completes.

---

### Phase 1: Vision Analysis (Workflow steps)

| # | Step | Per-page? | Duration est. | Notes |
|---|---|---|---|---|
| 1 | `roboflow-page-analyze` | Yes — batch 5-6 pages/step | ~30-60s/step | Roboflow API for panel bounding boxes + bubble bounding boxes + SAM3 segmentation |
| 2 | `extract-foreground-masks` | Yes — batch 5-6 pages/step | ~30-60s/step | SAM3 segmentation API |
| 3 | `character-lookahead` | Yes — per-page | ~10-20s/page | Gemini face matching against **book-level face gallery** (see below) |

**~35-40 workflow steps** for a 26-page issue. Each well within the 300s function timeout.

---

### Phase 2: Human Review — Character Clusters (NEW)

| # | Step | Type |
|---|---|---|
| 4 | `prepare-cluster-review` | Workflow step — compute review queue |
| 5 | `hook: await-cluster-review` | `defineHook()` — zero-cost suspend |

**Browser UI:** `/admin/{bookId}/{issueId}/review/clusters`

Shows face clusters with assigned names. The reviewer can:
- **Confirm** correct clusters → exemplar face crops are saved to the book-level gallery
- **Rename** misidentified clusters → fixes the character assignment
- **Merge** two clusters that are the same character
- **Split** a cluster that incorrectly grouped two characters
- **Add exemplar** — pick the clearest/best crop from the cluster to persist

On "Complete Review," the confirmed exemplars are uploaded to the face gallery and the workflow resumes.

---

### Book-Level Face Gallery

**Problem:** Today, character-lookahead starts cold every issue. The roster carries names but not visual references. Gemini has to re-discover every character's face from scratch.

**Solution:** Persist confirmed face exemplars at the book level. Each subsequent issue gets warm-start matching.

```
Supabase Storage: comic-character-faces/{bookId}/{characterId}/
  exemplar-01.webp   ← clearest face crop from issue 1 (human-confirmed)
  exemplar-02.webp   ← different angle from issue 2
  exemplar-03.webp   ← costume variant from issue 3
```

**DB table:**

```sql
CREATE TABLE character_face_exemplars (
  id            uuid primary key default gen_random_uuid(),
  character_id  text not null references characters(id),
  book_id       text not null,
  source_issue  text not null,         -- which issue this crop came from
  page_number   int not null,
  crop_path     text not null,         -- storage path in comic-character-faces bucket
  confidence    real not null default 0,
  is_confirmed  boolean default false, -- human-confirmed during cluster review
  created_at    timestamptz default now()
);

CREATE INDEX face_exemplars_book ON character_face_exemplars(book_id, character_id)
  WHERE is_confirmed = true;
```

**How character-lookahead uses it:**

1. Load 2-3 confirmed exemplar crops per character from the gallery
2. Feed exemplar images to Gemini alongside each new face crop
3. Gemini matches with **visual reference** instead of just names
4. New clusters (characters not in the gallery) still get identified by name from the roster/wiki

**Gallery growth:** After each issue's cluster review, confirmed exemplars are added. Issue 1 builds the initial gallery. By issue 4, Gemini has 3-4 reference faces per major character — matching is fast and accurate.

**Cross-book sharing:** The gallery is book-scoped by default, but characters that appear across books (e.g., the Turtles in multiple crossover series) could share exemplars via the global `characters` table. This is a future optimization.

---

### Phase 3: OCR + Context (Workflow steps)

| # | Step | Per-page? | Duration est. | Notes |
|---|---|---|---|---|
| 6 | `get-context` | Yes — per-page | ~10-20s/page | Roboflow crop + Gemini OCR + speaker/emotion. Uses confirmed character IDs from Phase 2 |

**~26 workflow steps.** The heaviest phase — each page involves a Roboflow crop extraction and Gemini vision call. Per-page granularity means failures retry only the failed page.

---

### Phase 4: Sort + Human Review (combined)

| # | Step | Type |
|---|---|---|
| 7 | `sort-page-elements` | Workflow step — Gemini sorts panels AND bubbles-within-panels per page. One call per page (~26 steps) |
| 8 | `add-bubble-styles` | Workflow step — pure math, % coords (<1s) |
| 9 | `hook: await-page-review` | `defineHook()` — zero-cost suspend |

**`sort-page-elements`** replaces the old `sort-bubbles-gemini`. In a single Gemini call per page, it:
- Validates/fixes panel reading order (top-to-bottom rows, left-to-right, handling irregular layouts)
- Sorts bubbles within each panel in correct reading order
- Uses panel bounding boxes from `roboflow-page-analyze` (already in the `panels` table with `sort_order` and `bounding_box`)

**Browser UI:** `/book/{bookId}/{issueId}/review?mode=pipeline`

Uses the **existing review route** with a pipeline mode flag. In one pass through the book, the reviewer can:
- **Verify/fix speakers** — all characters shown (unknowns highlighted first, then auto-accepted for confirmation)
- **Verify/fix bubble sort order** — drag to reorder within panels
- **Verify/fix panel sort order** — drag to reorder panels on a page
- **"Complete Pipeline Review"** button resumes the workflow

This replaces the standalone `/admin/{bookId}/{issueId}/review/speakers` step in the pipeline. That page still exists for quick fixes outside the pipeline, but the pipeline review is done in the full review UI.

---

### Phase 5: Voice Processing (Workflow steps)

| # | Step | Duration est. | Notes |
|---|---|---|---|
| 10 | `generate-voice-descriptions` | ~10-30s | Gemini consolidates voice descriptions per character |
| 11 | `clean-voice-descriptions` | <1s | Alias resolution |

**2 workflow steps.**

---

### Phase 6: Human Review — Characters + Casting

| # | Step | Type |
|---|---|---|
| 12 | `prepare-character-review` | Workflow step — compute new character queue |
| 13 | `hook: await-character-review` | `defineHook()` — zero-cost suspend |
| 14 | `prepare-casting` | Workflow step — create casting tasks |
| 15 | `hook: await-casting` | `defineHook()` — zero-cost suspend |

**Browser UIs:** (both already built)
- `/admin/{bookId}/{issueId}/review/new-characters`
- `/admin/characters/casting?book={bookId}&issue={issueId}`

---

### Phase 7: Voice Generation (Workflow steps)

| # | Step | Duration est. | Notes |
|---|---|---|---|
| 16 | `voice-rotation-checkout` | ~10s | ElevenLabs API — free up voice slots for new characters |
| 17 | `generate-voice-models` | ~30-60s/character | ElevenLabs IVC creation. Per-character steps (3-8 typically) |
| 18 | `generate-audio` | ~60-120s/batch | ElevenLabs TTS. Batch ~20 bubbles per step (~10 steps for 200 bubbles) |

**~15-20 workflow steps.**

---

### Phase 8: Publishing (Workflow steps)

| # | Step | Duration est. | Notes |
|---|---|---|---|
| 19 | `upload-audio` | ~30-60s | Audio files to Supabase Storage (WebP already uploaded during download) |
| 20 | `consolidate-music-scenes` | <10s | Process music cue data |
| 21 | `generate-manifest` | <1s | Update DB counts + status = 'ready' |

**3 workflow steps.**

---

### Phase 9: Voice Archival (Optional, human-triggered, decoupled)

**NOT part of the pipeline.** This is a separate maintenance action.

**Browser UI:** `/admin/voices/archive`

- Shows all active IVC voices with checkboxes
- Grouped by book — voices used only by completed books are highlighted as archive candidates
- "Archive Selected" button — frees ElevenLabs IVC slots
- "Archive All for Book" convenience button
- User decides when to archive (e.g., after finishing the last issue in a series)

---

## Workflow Budget Per Run

| Phase | Steps | Human pause? |
|---|---|---|
| 1: Vision Analysis | ~35-40 | — |
| 2: Cluster Review | 2 | Yes |
| 3: OCR + Context | ~26 | — |
| 4: Sort + Review | ~28 | Yes |
| 5: Voice Processing | 2 | — |
| 6: Characters + Casting | 4 | Yes (×2) |
| 7: Voice Generation | ~15-20 | — |
| 8: Publishing | 3 | — |
| 9: Voice Archival | — | Optional, manual, decoupled |
| **Total** | **~115-125** | **4 pause points** |

At ~3 events per step = ~345-375 events per run. **Hobby tier (50K free) supports ~130 full pipeline runs/month.** More than enough.

---

## Vercel Workflow Integration

### Hooks for human review

Each human review step uses `defineHook()`:

```ts
const clusterReviewHook = defineHook<{ approved: boolean }>();

// ... after character-lookahead steps complete ...

const token = `${bookId}/${issueId}/cluster-review`;
await clusterReviewHook.create({ token });

// Workflow suspends here — zero compute cost
const reviewResult = await clusterReviewHook;
// Resumes when browser UI calls hook.resume(token, { approved: true })
```

The browser review UI's "Complete Review" action calls:
```ts
await hook.resume(token, { approved: true });
```

### Step retry

Each workflow step retries independently on failure. If Gemini flakes on page 12's OCR, only page 12 re-executes — not the whole pipeline.

### Skew protection

Existing runs stay on the deployment they started on. New deploys don't break in-flight pipeline runs.

---

## Panel + Bubble Sort Details

### Data available at sort time

By the time `sort-page-elements` runs (Phase 4), we have:
- **Panel bounding boxes** — from `roboflow-page-analyze` (Phase 1), stored in `panels` table with `sort_order` and `bounding_box`
- **Bubble bounding boxes** — from `roboflow-page-analyze`, stored in `bubbles` table with coordinates
- **Bubble-to-panel assignment** — `bubbles.panel_id` FK linking each bubble to its panel
- **Page images** — WebP in `comic-pages` bucket (for Gemini vision context)

### What `sort-page-elements` does per page

Single Gemini call with the page image + panel/bubble coordinate overlay:

1. **Validate panel reading order** — the Roboflow heuristic (`sortReadingOrder`: top-to-bottom rows, left-to-right) handles standard grids well, but irregular/manga layouts need AI judgment
2. **Sort bubbles within each panel** — reading order within the panel's bounding box
3. **Output:** ordered list of `panel_id` → ordered list of `bubble_id` within each panel

Updates `panels.sort_order` and `bubbles.sort_order` in the DB.

### Review UI shows both

In the pipeline review (`/book/{bookId}/{issueId}/review?mode=pipeline`):
- Panels are numbered (1, 2, 3...) with drag-to-reorder
- Bubbles within each panel are numbered (1a, 1b, 1c, 2a, 2b...) with drag-to-reorder
- Speaker attribution shown per bubble with ability to reassign
- Changes saved to DB on "Complete Pipeline Review"

---

## Local Worker (Dev/Debug Fallback)

The existing `scripts/ingest-worker.ts` remains as a development fallback for:
- Running the full pipeline locally when iterating on step logic
- Debugging individual steps without deploying
- Emergency fallback if Vercel Workflows has issues

The worker polls Supabase for `pipeline_step = 'queued'`, downloads source pages, runs steps via `pnpm {step}`, and updates the DB. Not the production path.

---

## Implementation Order

1. **WebP + metadata as download side effects** — modify `/api/admin/download-pages` (ready to implement)
2. **Face gallery schema + storage bucket** — `character_face_exemplars` table + `comic-character-faces` bucket
3. **Cluster review UI** — `/admin/{bookId}/{issueId}/review/clusters`
4. **Update character-lookahead** — read exemplars from gallery, warm-start matching
5. **`sort-page-elements` step** — replace `sort-bubbles-gemini` with combined panel + bubble sort
6. **Pipeline review mode** — add `?mode=pipeline` to existing review UI (speakers + sort order + panel order in one pass)
7. **Vercel Workflow skeleton** — `"use workflow"` + `"use step"` for the full pipeline
8. **Migrate steps to workflow** — one phase at a time, starting with Phase 5 (simplest)
9. **Hook integration** — wire browser review UIs to `hook.resume()`

---

## Environment Variables

```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ROBOFLOW_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

---

## Security

- Workflow steps authenticate to Supabase via `SUPABASE_SECRET_KEY` (service role)
- Hook resume tokens are scoped to `{bookId}/{issueId}/{step}` — predictable but not public
- The trigger API should verify the request is from an authenticated admin
