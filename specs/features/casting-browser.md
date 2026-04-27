# Feature: Casting Browser UI

## Status: `pending`
## Prerequisite: Phase A (Storage) + Phase B (DB schema) + Phase D (pipeline writes to DB)
## Replaces (eventually): terminal `find-voice-sources` (step 9) + `generate-voice-models` (step 10) human pause

---

## Purpose

Steps 9 and 10 are the two most friction-heavy steps in the current pipeline:

- **Step 9 (`find-voice-sources`):** Gemini researches media appearances per character. The terminal presents suggestions; user picks one or types a custom source. Result saved to `data/source-material.json`.
- **Step 10 (`generate-voice-models`):** Pipeline pauses. User manually downloads the audio clip from the suggested source (usually YouTube via yt-dlp), then presses Enter. ElevenLabs creates a PVC voice model from the clip.

These two steps require a terminal, a local yt-dlp install, and careful coordination of three files (`source-material.json`, `castlist.json`, `character-registry.json`).

The casting browser UI collapses both into a single browser flow:
1. Gemini suggestions shown as interactive cards
2. User accepts a suggestion → server downloads the clip via yt-dlp
3. OR user uploads their own clip file directly
4. ElevenLabs voice model creation happens server-side
5. Status polling shows when the model is ready
6. Registry and castlist updated in DB automatically

**Scope note:** Voice models are **character-level assets**, not per-issue. Once "Raphael" has a voice model in the registry, every subsequent issue with Raphael skips casting entirely. The casting UI fires rarely once the main cast is established for a book.

---

## Schema Additions Required

### New bucket: `comic-voice-clips`

```
Bucket: comic-voice-clips
Access: Private (service role only)
Path:   {characterId}/{appearanceId}.mp3  (or .mp4 — clip format varies)
```

Add to Phase A storage spec.

### New columns on `character_appearances`

```sql
ALTER TABLE character_appearances
  ADD COLUMN clip_storage_path  text,         -- path in comic-voice-clips bucket
  ADD COLUMN clip_source_url    text,         -- YouTube/source URL the clip came from
  ADD COLUMN clip_duration_secs float,        -- used to verify clip is long enough for PVC
  ADD COLUMN voice_model_status text          -- 'pending' | 'processing' | 'ready' | 'failed'
    NOT NULL DEFAULT 'pending',
  ADD COLUMN voice_model_error  text,         -- error message if voice_model_status='failed'
  ADD COLUMN voice_model_started_at timestamptz;
```

The existing `voice_status` column (`"ready" | "pending"`) is kept for backwards compat but `voice_model_status` is more granular — add `processing` and `failed` states that the browser UI needs.

### New table: `casting_tasks`

Tracks which characters need casting for a given issue. The pipeline creates a row per new character when it reaches step 9. The browser UI reads these rows to know what needs casting.

```sql
CREATE TABLE casting_tasks (
  id             uuid primary key default gen_random_uuid(),
  book_id        text not null,
  issue_id       text not null,
  character_id   text not null references characters(id),
  status         text not null default 'pending',  -- pending | in_progress | complete | skipped
  created_at     timestamptz default now(),
  completed_at   timestamptz,
  UNIQUE (book_id, issue_id, character_id),
  FOREIGN KEY (book_id, issue_id) REFERENCES issues(book_id, id)
);

CREATE INDEX casting_tasks_pending ON casting_tasks(book_id, issue_id, status)
  WHERE status = 'pending';
```

**Why not reuse `pipeline_runs.steps`?** Same reason as `speaker_reviews` — each casting task is a per-character entity the UI needs to read and write independently. JSONB doesn't serve that access pattern.

---

## Pipeline Integration (Steps 9–10)

### New `--db` mode for step 9

```bash
pnpm find-voice-sources -- --book tmnt-mmpr-iii --issue 3 --db
```

1. Identify characters needing casting: `bubbles` WHERE `speaker IS NOT NULL` AND the speaker has no `voice_id` in `castlist` for this issue AND is not in the global registry with `voice_status='ready'`
2. For each such character: run Gemini appearance research (same as today)
3. Write results to `character_appearances` rows in DB (Gemini suggestions become `character_appearances` rows with `voice_model_status='pending'`)
4. Create a `casting_tasks` row for each character with `status='pending'`
5. Update `issues` with `pipeline_paused=true, pipeline_paused_at='find-voice-sources', pipeline_paused_url='/admin/characters/casting?book={bookId}&issue={issueId}'`
6. Exit with code 2 (pause signal)

### Step 10 handled by browser UI

`generate-voice-models` no longer needs a human pause in `--db` mode — the browser UI handles clip sourcing. After the casting UI marks all `casting_tasks` for the issue as `complete`, the pipeline re-runs from step 9 (finds 0 pending tasks → advances through step 10 automatically using the `clip_storage_path` already in `character_appearances`).

The `generate-voice-models` script gets a `--from-db` flag that reads `clip_storage_path` from `character_appearances` instead of downloading clips from local disk.

---

## Browser UI

### Route

```
/admin/characters/casting?book={bookId}&issue={issueId}
```

Query params scope the view to characters needed for a specific issue. Without params, shows all characters with `voice_model_status != 'ready'` across all issues.

Protected by `APPLY_FIXES_SECRET`.

---

### Page Layout

**Header:** "Casting — TMNT x MMPR III, Issue 3" with progress "2 of 5 characters cast"

**Character cards** — one per `casting_tasks` row with `status='pending'`:

```
┌──────────────────────────────────────────────────────────────┐
│  Goldar                               Franchise: MMPR        │
│                                                              │
│  Gemini Suggestions:                                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ★  Mighty Morphin Power Rangers (1993–1996)         │    │
│  │    Voice: Kerrigan Mahan · YouTube: "goldar mmpr"   │    │
│  │    [Use this source]                                │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │    Power Rangers Zeo (1996)                         │    │
│  │    Voice: Kerrigan Mahan · YouTube: "goldar zeo"    │    │
│  │    [Use this source]                                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ── or ──                                                    │
│  [ Upload clip directly ]   [ Use Voice Design instead ]    │
└──────────────────────────────────────────────────────────────┘
```

**After "Use this source":** The card transitions to a clip sourcing state:

```
┌──────────────────────────────────────────────────────────────┐
│  Goldar  ·  Mighty Morphin Power Rangers (1993)              │
│                                                              │
│  Source: youtube "goldar mmpr voice clips"                   │
│  ┌────────────────────────────────────────────────────┐     │
│  │  Fetching clip...  ████████████░░░░  60%           │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  [ Cancel ]                                                  │
└──────────────────────────────────────────────────────────────┘
```

Once the clip is fetched and validated (≥ 1 minute of speech, good quality signal), ElevenLabs PVC creation starts automatically:

```
┌──────────────────────────────────────────────────────────────┐
│  Goldar  ✓ Clip ready (2:34)                                 │
│  Creating voice model...  ⏳  (usually 1–3 minutes)          │
│                                                              │
│  [ Cancel & try different source ]                           │
└──────────────────────────────────────────────────────────────┘
```

On success:
```
┌──────────────────────────────────────────────────────────────┐
│  Goldar  ✓ Voice model ready                    [▶ Preview] │
│  ElevenLabs ID: abc123def456                                 │
│  Source: MMPR (1993) · Kerrigan Mahan                       │
└──────────────────────────────────────────────────────────────┘
```

---

### "Upload Clip Directly" Flow

File input accepts MP3/MP4/WAV. On upload:
1. Client uploads directly to `comic-voice-clips` bucket via signed URL (same pattern as source page uploads)
2. Server validates: duration ≥ 60 seconds, audio is present
3. ElevenLabs PVC creation triggered automatically (same server action as the YouTube flow)
4. Card shows the same progress/success states as above

---

### "Use Voice Design Instead" Flow

For minor characters or background voices where PVC isn't worth it. Opens a text input for the voice description (pre-populated from Gemini's `voice_description` in `character_appearances`). Submitting creates an ElevenLabs Voice Design voice (the existing `generate-voice-models --voice-design` path) and marks the task complete.

---

### "Complete Casting" Button

Appears when all `casting_tasks` for the issue are `complete` or `skipped`. Clicking:
1. Upserts `castlist` rows for this issue — `character → voice_id` from the completed `character_appearances`
2. Updates `issues.pipeline_paused = false`
3. Shows "Return to pipeline: `pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step find-voice-sources`"

Future: a "Resume Pipeline" button triggers this automatically via GH Actions.

---

### Server Actions

**`/api/fetch-voice-clip`** — Server action called when user selects a YouTube source:
```typescript
// POST { characterId, appearanceId, youtubeSearchTerms }
// 1. Run yt-dlp server-side to download best audio clip (first 5 min max)
// 2. Upload to comic-voice-clips/{characterId}/{appearanceId}.mp3
// 3. Update character_appearances: clip_storage_path, clip_source_url, clip_duration_secs
// 4. Return { storagePath, durationSecs }
```

`youtube-dl-exec` runs fine as a child process in a Next.js API route or server action. The 5-minute clip max keeps file sizes reasonable and ElevenLabs is fine with shorter clips.

**`/api/create-voice-model`** — Called after clip is ready:
```typescript
// POST { characterId, appearanceId }
// 1. Read clip from comic-voice-clips bucket
// 2. Call ElevenLabs PVC or Voice Design API
// 3. Poll ElevenLabs for status (or use webhook if available)
// 4. On ready: update character_appearances voice_id, voice_model_status='ready'
// 5. Return { voiceId, status }
```

ElevenLabs PVC creation takes 1–5 minutes. The browser polls `/api/voice-model-status?appearanceId={id}` every 10 seconds until `voice_model_status='ready'` or `'failed'`.

---

## Schema Summary — Changes to Phase A and Phase B

### Phase A additions:
- New bucket: `comic-voice-clips` (private)

### Phase B additions:
1. **New columns on `character_appearances`:**
   - `clip_storage_path text`
   - `clip_source_url text`
   - `clip_duration_secs float`
   - `voice_model_status text NOT NULL DEFAULT 'pending'` (replaces `voice_status` for granularity)
   - `voice_model_error text`
   - `voice_model_started_at timestamptz`
2. **New table: `casting_tasks`** (full DDL above)

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `specs/features/data-hosting/phase-a-storage.md` | Add `comic-voice-clips` bucket |
| `specs/features/data-hosting/phase-b-database.md` | Add columns to `character_appearances`; add `casting_tasks` table |
| `scripts/find-voice-sources.ts` | Add `--db` mode: write Gemini suggestions to DB, create `casting_tasks`, exit code 2 |
| `scripts/generate-voice-models.ts` | Add `--from-db` flag: read `clip_storage_path` from DB instead of local files |
| `scripts/ingest.ts` | Handle pause exit code from `find-voice-sources`; update `issues` pipeline state |
| `src/app/admin/characters/casting/page.tsx` | New casting UI page |
| `src/app/api/fetch-voice-clip/route.ts` | yt-dlp clip download + Storage upload |
| `src/app/api/create-voice-model/route.ts` | ElevenLabs PVC/Voice Design creation |
| `src/app/api/voice-model-status/route.ts` | Status polling endpoint |

---

## Build Order Within This Feature

1. **Schema additions** — `casting_tasks`, `character_appearances` columns, `comic-voice-clips` bucket
2. **`find-voice-sources --db` mode** — pipeline step that writes to DB and pauses cleanly
3. **`generate-voice-models --from-db` flag** — reads clip from DB/bucket
4. **`/api/fetch-voice-clip`** — yt-dlp server-side download
5. **`/api/create-voice-model` + `/api/voice-model-status`** — ElevenLabs integration
6. **Casting UI page** — ties everything together; blocks on all above

---

## Verification

```bash
# 1. Run pipeline to step 9 in --db mode:
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step find-voice-sources
# → Gemini suggestions written to character_appearances
# → casting_tasks created for new characters
# → Pipeline pauses with casting URL

# 2. Open /admin/characters/casting?book=tmnt-mmpr-iii&issue=3
# - Character cards show Gemini suggestions
# - Pick a source for one character → clip downloads → ElevenLabs model created
# - Use Voice Design for a minor character

# 3. After all tasks complete: click "Complete Casting"
# → castlist rows upserted in DB
# → issues.pipeline_paused = false

# 4. Re-run pipeline from step 9:
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step find-voice-sources
# → Finds 0 pending casting_tasks → advances through step 10 automatically

pnpm typecheck
```
