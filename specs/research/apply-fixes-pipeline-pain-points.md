# Research: Apply-Fixes Pipeline Pain Points and DB Migration Value

**Date:** 2026-04-27  
**Context:** Written to inform the `specs/features/data-hosting` plan. Summarizes the concrete issues encountered running the issue-1 audio repair and fix workflows, and maps each pain point to the DB/storage architecture that would eliminate it.

---

## What We Were Doing (The Scenario)

During issue-1 QA we discovered that a previous repair script had incorrectly renamed a batch of audio files. Bubbles were associated with the wrong MP3s — the audio content didn't match the `ocr_text` in `bubbles.json`. The repair required:

1. Diagnosing which files were mismatched by comparing ElevenLabs `audio-timestamps.json` text content against `bubbles.json` OCR text.
2. Writing a one-off Node.js repair script to chain-rename MP3s, swap timestamp entries, and update `needsAudio` flags.
3. Re-running `generate-audio --only-flagged` for 6 bubbles.
4. Re-running `copy-to-public` and `generate-manifest`.
5. Separately fixing a speaker name (Splinter → Master Splinter), adding an alias-map entry, re-flagging 4 more bubbles, and repeating steps 3–4.

This touched at least 6 files (`bubbles.json`, `audio-timestamps.json`, `alias-map.json`, plus `public/` copies of each), required understanding file rename ordering to avoid data loss, and produced stale backup directories.

---

## Root Cause #1 — Bubble IDs Encode Sort Order

**The problem:**

Bubble IDs follow the pattern `page-{NN}_b{NN}` — e.g., `page-07_b08`. The `b08` suffix is not a stable identifier; it is the bubble's **position in reading order on that page at the time the ID was assigned**. Audio files and timestamp keys use the same ID:

```
assets/comics/tmnt-mmpr-iii/issue-1/audio/page-07_b08.mp3
audio-timestamps.json: { "page-07_b08": { alignment: {...} } }
```

When reading order changes — whether because `sort-bubbles-gemini` re-runs, `apply-fixes` applies a reorder, or a manual correction is needed — the ID that was positionally correct is now wrong. The content of the audio file hasn't changed, but its name claims it belongs to a different reading-order slot.

**What this forced us to do:**

Write a bespoke repair script that:
- Processed chain renames in strict reverse order (b11→b12 before b10→b11, etc.) to avoid overwriting existing files mid-chain.
- Used temp-file patterns for swaps (b02→tmp, b03→b02, tmp→b03) to avoid data loss.
- Kept both the MP3 directory and `audio-timestamps.json` in sync — each rename required two corresponding operations.
- Verified the repair by joining timestamp text content against `ocr_text`, stripping leading performance cue markers like `[shouting]` before comparison, because naïve text matching produced false positives.

**With a hosted database:**

Bubbles get stable UUIDs assigned at insert time, independent of sort order. `sort_order` becomes a column:

```sql
UPDATE bubbles SET sort_order = 2 WHERE id = 'some-stable-uuid';
```

The audio file in Storage is named by the stable ID, not the position. Re-sorting is a column update; no file renames, no timestamp key renames, no repair scripts.

The `page-{NN}_b{NN}` ID pattern can be kept as a `display_id` or `legacy_id` column for human readability in logs, but it is never used as a storage key.

---

## Root Cause #2 — JSON Files as a Mutable Database

**The problem:**

`bubbles.json` is a `Record<string, Bubble[]>` keyed by page filename (e.g., `"page-07.jpg"`). Every script that modifies bubble data does a full read-modify-write of the entire file:

```
read bubbles.json (424 KB for issue-1) →
  mutate entries in memory →
    write entire file back
```

Multiple pipeline scripts (`apply-fixes`, `generate-audio`, `sort-bubbles-gemini`, `repair-cues`, `backfill-context`) all operate on the same file. Problems this causes:

- **No partial writes.** Fixing one bubble's speaker name requires reading and re-serializing ~400 KB. For large issues this is slow and any interrupt mid-write corrupts the file.
- **Repairs require understanding the entire file structure.** The chain-rename repair script had to parse the full JSON, locate the right page key, find entries by ID, swap or delete entries, and write back — all by hand because there's no query interface.
- **`audio-timestamps.json` is a separate but coupled file.** Bubble ID changes require identical changes in two files. If one gets updated and the other doesn't (e.g., script is interrupted), the data is inconsistent with no way to detect it except manually.
- **No history or audit trail.** Once a `bubbles.json` write happens, the previous state is gone unless you made a backup manually. The `backup/` directory in `audio/` is a hand-rolled workaround.
- **`needsAudio` / `needsOcr` flags are transient state stored in the same file as durable data.** When a bug in the pipeline incorrectly clears these flags, there is no way to see what they were before.

**With a hosted database:**

Each bubble is a row. Mutations are targeted:

```sql
UPDATE bubbles SET speaker = 'Master Splinter', needs_audio = true
WHERE book_id = 'tmnt-mmpr-iii' AND issue_id = 'issue-1' AND id = 'page-23_b07';
```

The DB handles atomic writes, partial updates, and concurrent access. `audio_timestamps` rows have a FK to `bubbles` — referential integrity is enforced automatically, so a bubble can't be renamed without cascading or an explicit migration.

The `needs_audio` / `needs_ocr` flags live as `boolean` columns with default `false`. You can query `WHERE needs_audio = true` to get a precise list, and check history via `updated_at` + Supabase's built-in audit log.

---

## Root Cause #3 — Alias Resolution Is Global and Opaque

**The problem:**

`data/alias-map.json` is a flat JSON file of lowercase → canonical name mappings. During issue-1 work we discovered that:

1. The AI was writing `"Splinter"` as a speaker name.
2. `getCanonicalName("Master Splinter")` lowercased to `"master splinter"`, looked up in alias-map, and returned `"Splinter"` — pointing to the wrong key.
3. `castlist.json` had the entry under `"Master Splinter"`, so the lookup failed silently.
4. The failure produced a `no-match-characters.json` entry and skipped audio generation entirely — no error, just missing audio.

The root cause: the alias-map had `"master splinter": "Splinter"` (leftover from an earlier mapping attempt), which overrode the correct canonical name. Debugging required tracing through `alias-map.ts`, `getCanonicalName`, `generate-audio`, and `no-match-characters.json` to find the mismatch.

There is no tooling to audit alias-map correctness, check for circular mappings, or verify that all canonical names in the alias-map match keys in `castlist.json`.

**With a hosted database:**

The `aliases` table (specced in phase-b-database.md) adds:
- Scoped aliases (`global` / `series` / `book`) so a conflict in one book doesn't pollute others.
- Unique constraint on `(alias, scope, scope_id)` — no duplicate alias definitions possible.
- `manage-aliases` CLI for explicit add/remove/list operations instead of hand-editing JSON.
- Easy validation query: join `aliases` against `castlist` to find any canonical name in aliases that has no matching castlist entry.

---

## Root Cause #4 — Review Flow Requires Local Terminal

**The problem:**

The full correction cycle is:

```
Browser (IndexedDB edits) 
  → Export fixes.json 
  → pnpm apply-fixes 
  → pnpm generate-audio --only-flagged  
  → pnpm copy-to-public 
  → pnpm generate-manifest
```

This requires:
- A local dev environment running the full pipeline.
- Manual coordination of which fixes affect audio (and therefore need `generate-audio`).
- Running 3–4 commands in sequence, monitoring each for errors.
- No way to do a quick text correction ("fix this typo") without going through the full pipeline.

During the issue-1 repair session, we ran this cycle 3 separate times (once for the chain-rename repair, once for page-08 OCR fixes, once for Master Splinter aliases). Each cycle involved checking logs, verifying the output matched expectations, and copying files to `public/`.

There is also no way to verify a fix was applied correctly without running `pnpm dev` and checking the reader, or manually inspecting `bubbles.json`.

**With a hosted database (phase-e-review.md):**

The "Apply to DB" button POSTs `fixes.json` to `/api/apply-fixes`, which writes directly to Supabase and invalidates ISR cache. Non-audio corrections (text typos, speaker name fixes, sort order changes) are live on the deployed site in seconds. Audio regeneration is still local, but the `needs_audio` flag is set in the DB so the next pipeline run picks it up. The `sync-from-db` script pulls the current DB state to local `assets/` before running `generate-audio`.

---

## Additional Data Worth Moving to Storage or DB

### OCR Crops

**Current state:** `assets/comics/{book}/{issue}/data/ocr-crops/` contains JPEG crops of each detected speech bubble, one per Roboflow prediction, used as input for Gemini OCR. For issue-3, this directory is ~3.7 MB including the per-page `*-ocr-predictions.json` files.

**Why store them:**
- **Remote OCR re-runs.** The Phase E review flow can't re-OCR a bubble without the crop image available to Gemini. If crops are in a Storage bucket, a future `/api/ocr-bubble` route could accept a bubble ID, fetch the crop from Storage, re-run Gemini, and write the result to the DB — fully browser-initiated.
- **Debugging.** When OCR produces garbled text or misses a bubble, the crop image is the first thing to check. Without it being accessible outside your laptop, debugging requires re-running the full pipeline locally.
- **Incremental re-processing.** If the Gemini OCR model improves, you can re-OCR all crops for an issue without re-running Roboflow detection, because the crops are already available.

**Recommended approach:**

Add a `comic-ocr-crops` bucket (private — these are intermediate assets, not CDN content). Path: `{bookId}/{issueId}/page-{NN}/{bubbleId}.jpg`.

Size note: ~3.7 MB per issue is small. Even at 100 issues this is under 400 MB. Store them.

Apply light compression at upload time (WebP conversion, resize to 800px max dimension) to reduce size 50–70% with negligible quality loss for OCR purposes. The Gemini Vision model doesn't need full-resolution crops.

Add `crop_storage_path` to the `bubbles` table:

```sql
ALTER TABLE bubbles ADD COLUMN crop_storage_path text;
-- e.g. "tmnt-mmpr-iii/issue-1/page-07/page-07_b08.jpg"
```

---

### OCR Prediction JSON Files

**Current state:** `data/ocr-crops/*-ocr-predictions.json` — one file per page, containing the raw Roboflow bounding box output (class, confidence, x/y/w/h for each detected bubble).

**Why store them (optional but useful):**
- Reprocessing without re-running Roboflow (expensive API call, slow) if a bug is found downstream.
- Training data for a future Roboflow model re-train (issue #11 in CLAUDE.md known issues: "Roboflow model may benefit from re-training").
- Comparing old vs. new Roboflow output after a model update to understand what changed.

**Recommended approach:**

Store in the same `comic-ocr-crops` bucket under a `predictions/` prefix: `{bookId}/{issueId}/predictions/page-{NN}.json`. These are small (< 10 KB each) so storage cost is negligible. No DB table needed — the files stay as JSON in the bucket.

---

### Gemini Context Cache

**Current state:** `assets/comics/{book}/{issue}/data/gemini-context/` — per-page JSON cache of Gemini's full analysis (speaker identification, emotion, narrative context). These are large-ish blobs (~5–20 KB each) used by `backfill-context` and `get-context` to avoid re-running expensive Gemini Vision calls.

**Recommendation: keep local for now.** These are truly intermediate — they're only useful if you need to re-run a pipeline step. They don't benefit the frontend or review flow. If the pipeline ever moves to a server environment (future-scope.md), they'd need to be in Storage then.

---

### `source-material.json` and `character-voice-descriptions.json`

**Current state:** Per-issue files tracking which voice clips were sourced and which ElevenLabs voice IDs were created. Currently separate from `castlist.json`.

**Recommendation:** Migrate voice description and source material into the `character_appearances` table (already in the phase-b schema). The `voice_description` and `voice_status` columns cover this. Eliminates two more local JSON files from the pipeline's state surface.

---

## Recommended Additional Tables / Buckets

Beyond what's already specced in `phase-b-database.md`:

### New Bucket: `comic-ocr-crops`

| Bucket | Access | Path convention |
|--------|--------|----------------|
| `comic-ocr-crops` | Private (service role only) | `{bookId}/{issueId}/page-{NN}/{bubbleId}.webp` |
| `comic-ocr-crops` | Private | `{bookId}/{issueId}/predictions/page-{NN}.json` |

Private because these are pipeline intermediates, not CDN content.

### New Column on `bubbles`: `crop_storage_path text`

Lets the review UI and future `/api/ocr-bubble` routes look up the crop image for a given bubble without scanning the bucket.

### New Table: `pipeline_runs` (optional, forward-looking)

Tracks each pipeline execution and its per-step outcome. Enables future "what happened to this issue" diagnostics without reading `checkpoint.json` off your laptop.

```sql
CREATE TABLE pipeline_runs (
  id          uuid primary key default gen_random_uuid(),
  book_id     text not null,
  issue_id    text not null,
  started_at  timestamptz default now(),
  completed_at timestamptz,
  status      text not null default 'running',  -- running | done | failed
  steps       jsonb,  -- { stepName: { status, startedAt, completedAt, error } }
  foreign key (book_id, issue_id) references issues(book_id, id)
);
```

This replaces `checkpoint.json` and makes run history queryable from the dashboard.

---

## Summary: Pain Point → Fix Mapping

| Pain Point | Root Cause | DB/Storage Fix |
|-----------|------------|----------------|
| Audio file chain-rename repair | Bubble ID encodes sort order → file name must change when order changes | Stable UUID in DB; `sort_order` is a column; Storage key never changes |
| `audio-timestamps.json` sync | Keys match audio file names — rename one, must rename other | FK in `audio_timestamps` table; keyed by stable bubble ID |
| Alias map silent failures | Flat JSON, no validation, stale entries produce silent no-match | Scoped `aliases` table; manageable via CLI; joinable against castlist for validation |
| Full read-modify-write for single fix | No partial write support in JSON file | Targeted `UPDATE` or `DELETE` SQL query |
| No audit trail for bubble changes | `bubbles.json` is overwritten in place | `updated_at` column + Supabase audit log |
| Review cycle requires local terminal | `apply-fixes` writes to local files only | Phase E `/api/apply-fixes` route writes to DB; non-audio fixes go live immediately |
| OCR re-runs impossible without local pipeline | Crop images only on laptop | `comic-ocr-crops` bucket + `crop_storage_path` column enables browser-initiated re-OCR |
| Prediction data lost if laptop changes | `ocr-crops/*.json` is local only | Store in `comic-ocr-crops` bucket for pipeline portability and model retraining |

---

## Relationship to Existing Data-Hosting Specs

The `specs/features/data-hosting/` plan already covers the main migration path correctly. These notes add:

1. **Stable IDs as a first-class requirement** — Phase B should explicitly note that new bubbles inserted to the `bubbles` table get UUIDs, and the `page-{NN}_b{NN}` ID is preserved as `legacy_id` for continuity with existing `audio-timestamps.json` data during migration.
2. **`comic-ocr-crops` bucket** not yet in the storage plan — add as a Phase A or Phase D deliverable.
3. **`crop_storage_path` column** not yet in the bubbles schema — add to Phase B DDL.
4. **`pipeline_runs` table** as an optional Phase B addition — replaces `checkpoint.json` with a queryable history.
5. **Phase E sync loop** (`sync-from-db → generate-audio → publish-to-supabase`) should be documented as an explicit runbook, not just implied, since it's the path for any browser-initiated fix that requires audio regeneration.
