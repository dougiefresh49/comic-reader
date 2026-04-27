# Feature: Review Speakers — Browser UI

## Status: `pending`
## Prerequisite: Phase B (DB schema) + Phase D (pipeline writes to DB)
## Depends on: `review-speakers.md` (terminal implementation — already built)

---

## Purpose

The terminal `review-speakers` step (step 4.5) is fully implemented and works well. This spec adds a **browser-based version** of the same review, so the pipeline can pause at step 4.5 and the user can complete the review from any browser — no local terminal required.

The terminal flow stays available and is still the default for now. The browser UI becomes the primary flow once Phase D is live.

**Also covered here:** inline alias creation, which replaces the separate `interactive-alias-review` step (8.5) for the most common case. When a user renames a speaker, they get the option to persist that mapping as an alias so future issues auto-resolve it — no separate terminal step needed.

---

## Schema Addition Required (Phase B patch)

The existing Phase B schema has no place to store the per-speaker review decisions needed for the browser UI. Add a `speaker_reviews` table:

```sql
CREATE TABLE speaker_reviews (
  id            uuid primary key default gen_random_uuid(),
  book_id       text not null,
  issue_id      text not null,
  original_name text not null,    -- what Gemini wrote ("Winged Monster")
  resolved_name text,             -- corrected name ("Goldar"); null = not yet reviewed
  status        text not null default 'pending',  -- pending | accepted | renamed | skipped
  auto_accepted boolean not null default false,   -- true if pre-accepted by registry match
  save_as_alias boolean not null default false,   -- if true, also write to aliases table
  alias_scope   text,                             -- 'global' | 'book' — only relevant when save_as_alias=true
  reviewed_at   timestamptz,
  created_at    timestamptz default now(),
  UNIQUE (book_id, issue_id, original_name),
  FOREIGN KEY (book_id, issue_id) REFERENCES issues(book_id, id)
);

CREATE INDEX speaker_reviews_pending ON speaker_reviews(book_id, issue_id, status)
  WHERE status = 'pending';
```

**Why a table and not just the `pipeline_runs.steps` JSONB:** The review decisions are per-speaker entities that the browser UI needs to read, write, and list independently. JSONB inside pipeline_runs can't be queried per-speaker. The table also lets you see review history across multiple pipeline runs for the same issue.

---

## Pipeline Integration (Step 4.5)

The existing `scripts/review-speakers.ts` gets a new `--db` mode alongside the existing interactive and `--auto` modes.

### New `--db` mode behavior

```bash
pnpm review-speakers -- --book tmnt-mmpr-iii --issue 3 --db
```

1. Run auto-accept for all registry/roster matches (same logic as today)
2. Upsert auto-accepted speakers into `speaker_reviews` with `status='pending', auto_accepted=true, resolved_name=name` — these are pre-resolved and the browser UI shows them as greyed-out accepted rows
3. For each remaining unknown speaker: upsert into `speaker_reviews` with `status='pending', resolved_name=null`
4. Check whether any `status='pending' AND auto_accepted=false` rows exist for this issue
   - **None pending:** all speakers already resolved from a previous run → apply all resolutions to `bubbles` table and continue to step 5
   - **Some pending:** print message and exit with code 2 (distinct from error):
     ```
     ── Review speakers ─────────────────────────────────────
       7 speakers awaiting review.
       Open: /admin/tmnt-mmpr-iii/issue-3/review/speakers
       Run again after completing review to continue.
     ────────────────────────────────────────────────────────
     ```
5. When the user completes the browser review and clicks "Complete Review," a server action writes all resolutions to `bubbles` (renames in DB) and any requested aliases to `aliases`. The pipeline is then re-run from step 4.5 (finds 0 pending → advances to step 5).

### `ingest.ts` integration

The pipeline's step 4.5 runs `--db` mode by default when `STORAGE_MODE=supabase`. Falls back to the interactive terminal mode when `STORAGE_MODE=local`. This means the old terminal flow still works throughout the Phase A–D transition.

```typescript
// In ingest.ts step definition for review-speakers:
const mode = process.env.STORAGE_MODE === 'supabase' ? '--db' : '';
await runScript('review-speakers', ['--book', book, '--issue', issue, mode].filter(Boolean));
```

Exit code 2 from `--db` mode means "waiting for browser review" — `ingest.ts` should treat this as a clean pause (not an error), print the review URL, and exit. The user re-runs `pnpm ingest` after completing the browser review.

---

## Browser UI

### Route

```
/admin/[bookId]/[issueId]/review/speakers
```

Protected by the same `APPLY_FIXES_SECRET` used by Phase E (shared secret header check in the server component or middleware). Not public.

---

### Page Layout

Three sections:

**Header bar:**
- Issue title ("TMNT x MMPR III — Issue 3")
- Progress: "7 of 18 reviewed" with a progress bar
- "Complete Review" button — disabled until all non-auto speakers are resolved
- "Skip to pipeline" button — marks all remaining as accepted, for when you trust Gemini

**Auto-accepted section (collapsible, collapsed by default):**
- Shows the N characters that were pre-accepted by registry/roster match
- Displayed as a compact chip list: `✓ Donatello  ✓ Leonardo  ✓ Raphael  ...`
- Tap to expand full list

**Review queue (main area):**
Each unknown speaker is a card:

```
┌─────────────────────────────────────────────────────┐
│  "Winged Monster"           Pages: 8, 9  (3 bubbles)│
│  Sample: "HA HA, FOOL! THEY WON'T MAKE IT IN--"     │
│                                                      │
│  [Accept as-is]  [Rename ▾]  [Choose from list ▾]  │
│                                                      │
│  □ Also save as alias → [ Global ▾ ]                │
└─────────────────────────────────────────────────────┘
```

Resolved cards show their decision in green and move to a "Resolved" collapsed section below the queue. The user only sees unresolved cards in the main queue.

---

### Interaction Detail

**Accept as-is:** Marks the `speaker_reviews` row as `status='accepted', resolved_name=originalName`. No alias saved.

**Rename:** Inline text input appears. User types the corrected name. On confirm: `status='renamed', resolved_name=newName`. The "Also save as alias" checkbox becomes available.

**Choose from list:** Dropdown/popover showing:
1. Characters resolved earlier in this same session (most useful for spotting duplicates — "Wait, is this the same as 'Villain Green Ranger'?")
2. Characters from the `characters` table (registry) — searchable
3. Free-text input at the bottom for new names

Selecting from the list is equivalent to Rename.

**Also save as alias checkbox:** Available after a rename. When checked, a scope selector appears: `Global` / `This book only`. On "Complete Review," alias rows are written to the `aliases` table alongside the bubble renames.

**Sample text:** Clicking the sample text expands all bubbles for that speaker on that page — shows the full `ocr_text` for each, for context when the sample is ambiguous.

---

### "Complete Review" Action

When the user clicks "Complete Review":

1. Validate: all non-auto speakers have a resolved status (button is disabled otherwise)
2. Server action runs:
   a. For each `renamed` row: `UPDATE bubbles SET speaker = resolved_name WHERE speaker = original_name AND book_id = $bookId AND issue_id = $issueId`
   b. For each row with `save_as_alias = true`: `INSERT INTO aliases (alias, canonical, scope, scope_id)` — alias is `original_name.toLowerCase()`, canonical is `resolved_name`, scope from the selector
   c. Mark all `speaker_reviews` rows for this issue as complete (set `reviewed_at = now()`)
3. Show success: "Review complete. 4 renamed, 3 accepted, 2 aliases saved. Re-run the pipeline to continue."
4. The pipeline re-run from step 4.5 will now find 0 pending speakers and advance automatically.

---

### DB Reads for the Page

```typescript
// All speaker_reviews for this issue (ordered: unresolved first, then auto-accepted)
const reviews = await supabase
  .from('speaker_reviews')
  .select('*')
  .eq('book_id', bookId)
  .eq('issue_id', issueId)
  .order('auto_accepted', { ascending: true })
  .order('created_at', { ascending: true });

// Registry characters for the "Choose from list" dropdown
const characters = await supabase
  .from('characters')
  .select('id')
  .order('id');
```

The sample text and page/bubble counts come from the `speaker_reviews` rows themselves (populated by the pipeline step). We don't need to query `bubbles` on every page load — the review card data is self-contained.

Wait — the pipeline step needs to store the sample text and page/bubble counts when it creates the `speaker_reviews` rows. Add these columns:

```sql
-- Additional columns on speaker_reviews:
sample_text  text,         -- first ocr_text snippet for this speaker (≤80 chars)
page_numbers int[],        -- array of page numbers this speaker appears on
bubble_count int not null default 0
```

Update Phase B DDL accordingly.

---

## Effect on `interactive-alias-review` (Step 8.5)

Once the browser review UI is live, step 8.5 (`interactive-alias-review`) becomes mostly redundant for the common case:

- The most common step-8.5 situation (Gemini got the name completely wrong) is handled by step 4.5's browser rename + alias checkbox
- Step 8.5 is still useful for cases where two different AI-assigned names turned out to be the same character — but this can also be caught during the step 4.5 review via "Choose from list"

**Recommendation:** Keep the terminal `interactive-alias-review` step for now (it handles edge cases). Once the browser review UI ships and has been used for 2–3 issues, evaluate whether step 8.5 is still needed.

---

## Schema Summary — Changes to Phase B

Add to `phase-b-database.md`:

1. **New table: `speaker_reviews`** (full DDL above)
2. **Extra columns on `speaker_reviews`:** `sample_text text`, `page_numbers int[]`, `bubble_count int`

No changes needed to `bubbles`, `aliases`, or other existing tables — this is additive.

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `specs/features/data-hosting/phase-b-database.md` | Add `speaker_reviews` table to DDL |
| `scripts/review-speakers.ts` | Add `--db` mode (upsert to `speaker_reviews`, exit code 2 when pending) |
| `scripts/ingest.ts` | Handle exit code 2 from review-speakers as clean pause |
| `src/app/admin/[bookId]/[issueId]/review/speakers/page.tsx` | New browser UI page |
| `src/app/api/complete-speaker-review/route.ts` | Server action: apply renames + aliases to DB |

---

## Verification

```bash
# 1. Run pipeline to step 4.5 with STORAGE_MODE=supabase
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step get-context
# Should pause at review-speakers with exit code 2, print review URL

# 2. Open /admin/tmnt-mmpr-iii/issue-3/review/speakers
# - Known registry characters should appear in auto-accepted section
# - Unknown speakers appear as review cards
# - Rename "Winged Monster" → "Goldar", check "Save as alias (global)"
# - Complete review

# 3. Re-run pipeline from step 4.5
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step review-speakers
# Should find 0 pending, apply renames to bubbles table, advance to step 5

# 4. Verify
# - bubbles table: speaker = "Goldar" where legacy speaker was "Winged Monster"
# - aliases table: { alias: "winged monster", canonical: "Goldar", scope: "global" }
# - speaker_reviews table: all rows resolved for this issue

pnpm typecheck
```
