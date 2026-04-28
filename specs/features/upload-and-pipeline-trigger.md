# Feature: Source Page Upload + Cloud Pipeline Trigger

## Status: `pending`
## Prerequisite: Phase A (Storage buckets) + Phase B (DB schema) + Phase D (pipeline writes to DB)

---

## Purpose

Today the full pipeline runs locally from step 1. This feature does two things:

1. **`upload-source-pages` script** — after `scrape-pages` downloads JPEGs locally, a single command uploads them to the `comic-pages-raw` private bucket and registers the issue in the DB.
2. **`/admin/new-issue` upload page** — a browser drag-and-drop fallback for pages from sources other than a scrapeable URL (and a prerequisite for future cloud-triggered pipeline steps).

Once pages are in `comic-pages-raw`, steps 2–11 can be run against bucket files instead of local disk — either still locally (reading from the bucket) or eventually from a cloud job.

**What this does NOT do yet:** auto-trigger the full pipeline from the browser. The pipeline still runs locally via `pnpm ingest`. This feature just moves the raw source material into cloud storage and registers the issue, which unblocks the eventual cloud-trigger path.

---

## Schema Addition Required (Phase B patch)

The `issues` table currently has `status text` (`pending | processing | ready`) but nothing tracks pipeline state granularly enough to support cloud triggering or browser status display. Add a `pipeline_status` column and a `source_pages_bucket_path` column:

```sql
ALTER TABLE issues
  ADD COLUMN source_pages_path    text,      -- "tmnt-mmpr-iii/issue-3/source/" — prefix in comic-pages-raw bucket
  ADD COLUMN pipeline_step        text,      -- current or last-completed step name (e.g. "review-speakers")
  ADD COLUMN pipeline_paused      boolean NOT NULL DEFAULT false,  -- true when step exited with pause code (waiting for human)
  ADD COLUMN pipeline_paused_at   text,      -- step name where pipeline is paused
  ADD COLUMN pipeline_paused_url  text;      -- URL to the review page that unblocks it (e.g. /admin/.../review/speakers)
```

**Why not use `pipeline_runs.steps` JSONB for this?** The `pipeline_runs` table tracks run history — it's append-only. The `issues` table tracks *current* state. The admin UI needs to see at a glance: "issue 3 is paused at review-speakers — click here to continue." That needs to live on the `issues` row, not buried in a historical JSONB column.

Also add a `comic-pages-raw` bucket to Phase A (not yet in the storage spec):

```
Bucket: comic-pages-raw
Access: Private (service role only)
Path:   {bookId}/{issueId}/source/page-01.jpg
```

This is the input staging bucket — raw JPEGs go in here before conversion to WebP.

---

## Part 1: `upload-source-pages` Script

```bash
pnpm upload-source-pages -- --book tmnt-mmpr-iii --issue 3
```

**What it does:**

1. Reads `assets/comics/{book}/{issue}/pages/*.jpg` (source JPEGs from `scrape-pages`)
2. Uploads each to `comic-pages-raw/{bookId}/{issueId}/source/page-NN.jpg` — skips files already present (idempotent)
3. Upserts the `issues` row in the DB with `status='pending'`, `source_pages_path='{bookId}/{issueId}/source/'`, `pipeline_step=null`
4. Upserts the `books` row if it doesn't exist yet
5. Prints upload summary: "24 pages uploaded to comic-pages-raw/tmnt-mmpr-iii/issue-3/source/"

**Not included yet:** pipeline trigger. The script just uploads and registers. The user still runs `pnpm ingest` as normal. Future cloud trigger is a separate feature.

```typescript
// scripts/upload-source-pages.ts
// Usage: pnpm upload-source-pages -- --book <name> --issue <n>
// Uploads assets/comics/{book}/{issue}/pages/*.jpg → comic-pages-raw bucket
// Upserts issues row in DB
// Idempotent — safe to re-run after a partial upload
```

**Upload strategy:** Same as `upload-to-storage.ts` — `Promise.allSettled` with concurrency 10, log skipped/uploaded/failed separately. Pass `--force` to re-upload all (useful if source pages were re-scraped).

---

## Part 2: Pipeline Step 1 — Read from Bucket (Future-Compatible)

After `upload-source-pages` runs, step 1 (`validate-inputs`) can optionally verify the bucket has pages instead of (or in addition to) checking local disk. Add a `--from-bucket` flag to `validate-inputs.ts`:

```bash
# Today (local):
pnpm ingest -- --book tmnt-mmpr-iii --issue 3

# Future-compatible (local pipeline, but validates bucket content too):
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --verify-bucket
```

This isn't required for the initial upload feature but sets up the validation path for when the pipeline eventually reads from the bucket in steps 2–3.

---

## Part 3: `/admin/new-issue` Browser Upload Page

A drag-and-drop upload page for cases where `scrape-pages` wasn't used or pages come from a different source.

### Route

```
/admin/new-issue
```

Protected by `APPLY_FIXES_SECRET` (same shared secret pattern as Phase E).

### UI

**Step 1 — Book/Issue metadata:**
- Book ID input (text, e.g. `tmnt-mmpr-iii`) — autocomplete from existing `books` rows
- Issue number input (number)
- "New book" toggle — if checked, also show book name input

**Step 2 — Page upload:**
- Drag-and-drop zone: "Drop page JPEGs here, or click to select"
- Accepts multiple files; auto-sorts by filename (page-01.jpg, page-02.jpg, ...)
- Shows thumbnail grid as files are selected — user can verify order and remove any wrong files
- File count validation: warns if file count seems wrong (< 20 or > 40 pages for a typical issue)
- "Upload Pages" button

**Step 3 — Confirmation:**
- Upload progress per file
- On complete: "24 pages uploaded. Run `pnpm ingest -- --book tmnt-mmpr-iii --issue 3` to start the pipeline."
- Future (post cloud-trigger feature): "Start Pipeline" button appears here

### Upload Implementation

Files go directly from browser → Supabase Storage via the anon key and a Storage policy that allows authenticated uploads to `comic-pages-raw`. Since this is family-only and auth isn't built yet, use a short-lived signed upload URL generated by an API route:

```typescript
// src/app/api/upload-source-pages/route.ts
// POST { bookId, issueId, filename }
// Returns: { uploadUrl: string } — signed URL for direct browser-to-Storage upload
// Validates APPLY_FIXES_SECRET header
// Creates issues + books rows in DB if they don't exist
```

Browser calls this once per file to get a signed upload URL, then PUTs directly to Supabase Storage. This keeps large file transfers off the Vercel function (which has a 4.5 MB body limit).

---

## Part 4: Issue Status in Admin Dashboard

Add an `/admin` dashboard page that shows all issues and their pipeline status. This is the natural home for the "paused at review-speakers" state surfaced by the `issues` table additions.

```
/admin
```

Table showing:
| Book | Issue | Pages | Pipeline Step | Status | Actions |
|------|-------|-------|--------------|--------|---------|
| TMNT x MMPR III | Issue 3 | 24 | review-speakers | ⏸ Paused | [Review Speakers →] |
| TMNT x MMPR III | Issue 2 | 24 | — | ⬜ Not started | [Start Pipeline] |
| TMNT x MMPR III | Issue 1 | 26 | generate-manifest | ✅ Ready | [View] |

The `pipeline_paused_url` column on `issues` provides the link for the "Review Speakers →" action button directly — no hardcoded routing logic needed.

This dashboard reads from the `issues` table and is a simple server component. No interactivity needed beyond the action buttons.

---

## `ingest.ts` Updates

When `STORAGE_MODE=supabase`, `ingest.ts` should update `issues.pipeline_step` after each step completes, and set `pipeline_paused=true` + `pipeline_paused_url` when a step exits with pause code 2:

```typescript
// After each step completes:
await supabase.from('issues')
  .update({ pipeline_step: step.id, pipeline_paused: false })
  .eq('book_id', bookId).eq('id', issueId);

// When a step exits with code 2 (human pause):
await supabase.from('issues')
  .update({
    pipeline_paused: true,
    pipeline_paused_at: step.id,
    pipeline_paused_url: `/admin/${bookId}/${issueId}/review/${step.id.replace('review-', '')}`,
  })
  .eq('book_id', bookId).eq('id', issueId);
```

This makes the admin dashboard's status column live-updating from the running pipeline.

---

## Schema Summary — Changes to Phase B

Add to `phase-b-database.md`:

1. **New columns on `issues`:**
   - `source_pages_path text` — prefix in `comic-pages-raw` bucket
   - `pipeline_step text` — current/last pipeline step
   - `pipeline_paused boolean DEFAULT false`
   - `pipeline_paused_at text`
   - `pipeline_paused_url text`

2. **New bucket `comic-pages-raw`** — add to Phase A storage spec (private, service role + signed upload URLs)

---

## Build Order Within This Feature

1. **`upload-source-pages` script** — low effort, immediate value, no UI needed
2. **Phase A `comic-pages-raw` bucket** — required by the script
3. **`issues` table columns** — add to Phase B DDL before migration runs
4. **`/admin` dashboard** — reads `issues` table; simple server component
5. **`/admin/new-issue` upload page** — depends on signed upload URL API route
6. **`ingest.ts` pipeline step updates** — depends on `issues` table columns

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `specs/features/data-hosting/phase-a-storage.md` | Add `comic-pages-raw` bucket |
| `specs/features/data-hosting/phase-b-database.md` | Add 5 columns to `issues` table |
| `scripts/upload-source-pages.ts` | New script |
| `scripts/ingest.ts` | Update `issues` table after each step; handle pause exit code |
| `src/app/admin/page.tsx` | New dashboard page |
| `src/app/admin/new-issue/page.tsx` | New upload page |
| `src/app/api/upload-source-pages/route.ts` | Signed URL generator |

---

## Verification

```bash
# 1. After scrape-pages:
pnpm upload-source-pages -- --book tmnt-mmpr-iii --issue 3
# → 24 files in comic-pages-raw bucket
# → issues row upserted in DB with source_pages_path set

# 2. Run pipeline normally (still local)
pnpm ingest -- --book tmnt-mmpr-iii --issue 3
# → issues.pipeline_step updates after each step
# → When it hits review-speakers: issues.pipeline_paused=true, pipeline_paused_url set

# 3. Open /admin — see issue 3 in "Paused" state with link to review page
# 4. Open /admin/new-issue — upload a test JPEG, verify it lands in comic-pages-raw bucket

pnpm typecheck
```
