# Research: Path to Fully Web-Based Ingest

**Date:** 2026-04-27  
**Context:** Follow-up to `apply-fixes-pipeline-pain-points.md`. Answers the question: once crops and Gemini context are in cloud storage/DB, how close are we to running the full ingest and fix flows from the browser instead of the terminal?

---

## TL;DR

With the data-hosting migration complete (Phases A–E), roughly **75% of the pipeline** could be browser-initiated. The remaining 25% is either inherently local (scraping source pages) or interactive terminal steps that need browser UIs built for them. None of the blockers are architectural dead-ends — they're just work that hasn't been specced yet.

---

## Current Pipeline Step-by-Step Assessment

| Step | What it does | Cloud-ready after migration? | Blocker if no |
|------|-------------|------------------------------|---------------|
| `scrape-pages` | Stagehand drives a browser to download page images | ❌ Stays local | Drives a headed browser — can't run in a serverless function. Always a local step. |
| 1 `validate-inputs` | Check assets dir + pages exist | ❌ Needs local files | Depends on source JPEGs being on disk |
| 2 `generate-pages-metadata` | Extract JPEG dimensions | ✅ If JPEGs are in storage | `sharp` can process from a URL or buffer |
| 3 `convert-pages-to-webp` | JPEG → WebP | ✅ If JPEGs are in storage | `sharp` runs fine server-side; output goes to `comic-pages` bucket |
| 4 `get-context` | Roboflow detection + Gemini OCR + speaker/emotion | ✅ Pure API calls | Crops saved to `comic-ocr-crops` bucket; results written to DB |
| 4.5 `review-speakers` | Interactive terminal: accept/edit speaker names | ❌ Needs browser UI | Already specced (`review-speakers.md`) — a natural review UI page |
| 5 `sort-bubbles-gemini` | AI reorders bubbles | ✅ Pure API + DB write | — |
| 6 `add-bubble-styles` | Calculate % coords from bounding boxes | ✅ Pure computation | — |
| 7 `generate-character-voice-descriptions` | Gemini consolidates voice descriptions | ✅ Pure API + DB write | — |
| 8 `clean-voice-descriptions` | Normalize via alias-map | ✅ DB query for aliases | After Phase E alias scoping ships |
| 8.5 `interactive-alias-review` | Interactive terminal: confirm/create aliases | ❌ Needs browser UI | Specced as `pending` in features.md — guided menu for new character names |
| 9 `find-voice-sources` | Gemini researches voice clips; user picks source | ❌ Needs browser UI | The "casting" flow — rich enough to warrant its own review page |
| 10 `generate-voice-models` | ElevenLabs creates PVC voice models from clips | ✅ Pure API | Requires clips to be accessible — see note below |
| 11 `generate-audio` | ElevenLabs TTS for every bubble | ✅ Pure API + bucket write | Output goes to `comic-audio` bucket |
| 12 `publish-to-supabase` | Upload assets + upsert DB | ✅ Already cloud in Phase D | — |
| 13 `generate-manifest` | Update issues table counts | ✅ Already cloud in Phase D | — |

**Cloud-ready (9/15 steps):** steps 2, 3, 5, 6, 7, 8, 10, 11, 12/13.  
**Needs browser UI (3 steps):** steps 4.5, 8.5, 9.  
**Stays local (1 step):** `scrape-pages` — this is fine, it's the raw asset acquisition step.  
**Depends on source JPEG upload (2 steps):** 1, 2/3 — needs a page-upload mechanism.

---

## The Three Remaining Gaps

### Gap 1: Source JPEG Upload

Steps 1–3 all assume JPEGs are on the local filesystem. To trigger the pipeline from the browser, pages need to enter the system through a different path.

**Option A — Upload at start of pipeline:**  
A browser upload UI (`/admin/new-issue`) lets you drag-and-drop page JPEGs directly into a `comic-pages-raw` private bucket. Steps 2–3 run server-side as a background job (Next.js server action or a Vercel function) reading from that bucket.

**Option B — Scrape then upload (semi-local):**  
Keep `scrape-pages` local (it drives a browser, that's fine). After scraping, a short script uploads the downloaded JPEGs to `comic-pages-raw` and triggers the rest of the pipeline via API. The only local step is the actual scrape.

Option B is lower friction to implement and keeps the architecture clean — `scrape-pages` stays a local tool, everything after is cloud.

---

### Gap 2: Interactive Terminal Steps Need Browser UIs

Three pipeline steps are interactive menus that pause and wait for user input:

**`review-speakers` (step 4.5)** — already specced in `specs/features/review-speakers.md`. The natural home is a `/admin/issue/{bookId}/{issueId}/review-speakers` page that shows each AI-assigned speaker name with [Accept / Edit / Choose from list] options. Auto-accepts known registry characters. This is probably the most straightforward to build.

**`interactive-alias-review` (step 8.5)** — specced as `pending` in features.md. Shows new character names detected during ingestion. [1] Create new character / [2] Alias to existing list. Should prune stale characters against bubbles.json first. A simple modal or side panel in the admin review flow would cover this.

**`find-voice-sources` (step 9)** — the "casting" step. Gemini suggests voice clip sources (YouTube, etc.), user picks one, then ElevenLabs creates the PVC voice model. This is the richest interactive step — it probably deserves its own dedicated `/admin/issue/{bookId}/{issueId}/casting` page. Note: this is also the step most dependent on the user's taste/judgment, so the UI needs to be good.

---

### Gap 3: Voice Clip Sourcing for `generate-voice-models`

Step 10 (`generate-voice-models`) requires audio clips to already exist on disk before ElevenLabs can create PVC voice models from them. Today, `find-voice-sources` downloads clips via `youtube-dl-exec` based on the user's selection.

For cloud execution, those clips would need to be:
1. Downloaded server-side (yt-dlp running in a server/edge function), OR
2. Uploaded by the user from the browser (simpler, more reliable)

Option 2 is the pragmatic path: the casting UI (Gap 2 above) lets the user select a source, then provides a file upload input for the clip. The clip uploads to a `comic-voice-clips` private bucket. `generate-voice-models` reads from there when creating the ElevenLabs voice.

This is a minor lift on top of the casting UI — the same page handles both selection and upload.

---

## What OCR Crops and Gemini Context in Cloud Unlock

### OCR Crops in `comic-ocr-crops` bucket

Once crops are in Storage with `crop_storage_path` on the bubble row:

- **Review UI can display the crop image in `BubbleDetail`** — you see exactly what Gemini was reading when it produced the OCR text. Currently, the only way to see this is opening `viewer.html` locally.
- **Browser-initiated OCR re-run becomes possible** — a `/api/ocr-bubble` route fetches the crop from Storage, sends it to Gemini, writes the result back to `bubbles`. No local pipeline needed for fixing a single bad OCR result.
- **`viewer.html` files can be retired** — they were a pre-review-UI workaround. The review UI with inline crop display is strictly better.

### Gemini Context in DB

If the per-page Gemini analysis (speaker ID, emotion, narrative context) is persisted in the DB rather than only in local JSON cache:

- Re-running any downstream step (sort-bubbles, voice descriptions) doesn't require the local `gemini-context/` directory to exist.
- A cloud pipeline step can read context from the DB instead of from local files.
- Debugging "why did Gemini say this character was X" is a DB query, not a file dive.

**Recommended table addition to Phase B:**

```sql
CREATE TABLE page_context (
  book_id       text not null,
  issue_id      text not null,
  page_number   int not null,
  gemini_model  text,
  raw_response  jsonb,   -- full Gemini output; reference for re-runs and debugging
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  PRIMARY KEY (book_id, issue_id, page_number),
  FOREIGN KEY (book_id, issue_id) REFERENCES issues(book_id, id)
);
```

This replaces `assets/comics/{book}/{issue}/data/gemini-context/page-{NN}.json`. The `raw_response` JSONB column holds the full structured Gemini output — same data, now queryable and accessible to cloud steps.

---

## Recommended Implementation Order (Beyond Phase E)

Once the data-hosting migration is complete, building toward fully web-based ingest would go in this order:

1. **Option B source upload** — `scrape-pages` uploads to `comic-pages-raw`; pipeline trigger API route. Low effort, unlocks steps 2–11 as cloud jobs.
2. **Review-speakers browser UI** — already specced; smallest of the three interactive steps. Builds the pattern for the other two.
3. **Casting browser UI** (`find-voice-sources`)  — most user-facing complexity; deserves its own spec.
4. **Interactive alias review browser UI** — can share UI patterns from review-speakers.
5. **`page_context` table** — add to Phase B DDL; update `get-context` step to write to DB.
6. **OCR re-run API route** — `/api/ocr-bubble` reads crop from Storage, calls Gemini, writes to DB. Enables the zero-terminal fix loop for OCR errors.

At the end of this sequence, the only step that requires a terminal is `scrape-pages` — and that's a deliberate boundary, not a limitation.

---

## Summary

| Category | Today | After Phase A–E | After full web ingest build-out |
|----------|-------|-----------------|---------------------------------|
| Fix a typo | Export JSON → terminal → 4 commands | Click "Apply to DB" | Same |
| Fix bad OCR | terminal re-run | Still terminal (crops not in cloud yet) | Click "Re-OCR" in review UI |
| Add a new issue | All terminal | Still terminal | Upload pages in browser → trigger pipeline |
| Review speakers | Terminal interactive menu | Still terminal | Browser review page |
| Casting / voice models | Terminal interactive menu | Still terminal | Browser casting page |
| Check what Gemini said | Open local JSON file | DB query / admin UI | Same |
