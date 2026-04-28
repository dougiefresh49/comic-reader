# Phase B: Database Schema and Data Migration

Define the Supabase PostgreSQL schema and migrate all JSON data files into it.

**Prerequisite**: Phase A (Supabase project exists).

---

## Data Model

### Hierarchy

```
series (future — not implemented in Phase B, reserved)
  └── books
        └── issues
              ├── pages
              ├── bubbles
              │     └── audio_timestamps
              └── castlist
characters (global registry)
character_appearances (registry entries per character)
aliases (name normalization, scoped)
```

### Series (reserved, not yet used)

```sql
create table series (
  id         text primary key,        -- e.g. "tmnt-mmpr"
  name       text not null,
  created_at timestamptz default now()
);
```

This table exists but is not populated in Phase B. Books reference it optionally (`series_id` nullable). Populate it when the series data model is built.

---

### Books

```sql
create table books (
  id         text primary key,        -- e.g. "tmnt-mmpr-iii"
  series_id  text references series(id),
  name       text not null,           -- "TMNT x MMPR III"
  slug       text not null unique,
  created_at timestamptz default now()
);
```

---

### Issues

```sql
create table issues (
  id               text not null,           -- "issue-1"
  book_id          text not null references books(id),
  number           int not null,            -- 1
  name             text not null,           -- "Issue 1"
  page_count       int not null default 0,
  bubble_count     int not null default 0,
  audio_count      int not null default 0,
  has_webp         boolean not null default false,
  has_audio        boolean not null default false,
  has_timestamps   boolean not null default false,
  status           text not null default 'pending', -- pending | processing | ready
  -- Pipeline state tracking (used by admin dashboard + browser review flows)
  source_pages_path   text,         -- prefix in comic-pages-raw bucket, e.g. "tmnt-mmpr-iii/issue-3/source/"
  pipeline_step       text,         -- name of current or last-completed pipeline step
  pipeline_paused     boolean not null default false,  -- true when a step exited with human-review pause
  pipeline_paused_at  text,         -- step name where pipeline is paused
  pipeline_paused_url text,         -- URL to the review page that unblocks it, e.g. "/admin/.../review/speakers"
  created_at       timestamptz default now(),
  primary key (book_id, id)
);
```

---

### Pages

```sql
create table pages (
  id          serial primary key,
  book_id     text not null,
  issue_id    text not null,
  number      int not null,            -- 1-based
  width       int not null,
  height      int not null,
  storage_path text,                   -- e.g. "tmnt-mmpr-iii/issue-1/page-01.webp"
  foreign key (book_id, issue_id) references issues(book_id, id),
  unique (book_id, issue_id, number)
);
```

---

### Bubbles

This is the main table. One row per bubble.

```sql
create table bubbles (
  id              uuid primary key default gen_random_uuid(),
  legacy_id       text,                       -- "page-01_b01" — human-readable log reference only, never used as FK
  book_id         text not null,
  issue_id        text not null,
  page_number     int not null,               -- 1-based
  sort_order      int not null,               -- position within page (0-based); this is what updates on reorder, id never changes
  ocr_text        text,
  text_with_cues  text,
  type            text not null default 'SPEECH', -- SPEECH|NARRATION|CAPTION|SFX|BACKGROUND
  speaker         text,
  emotion         text,
  character_type  text,
  side            text,
  voice_description text,
  ai_reasoning    text,
  ignored         boolean not null default false,
  needs_audio     boolean not null default false,
  needs_ocr       boolean not null default false,
  -- box_2d and style stored as JSONB (irregular shapes, index field, etc.)
  box_2d          jsonb,
  style           jsonb,                      -- {left, top, width, height} as percentages
  audio_storage_path text,                    -- MP3 filename in comic-audio bucket (e.g. "page-07_b08.mp3" for migrated; "{uuid}.mp3" for new)
  crop_storage_path  text,                    -- path in comic-ocr-crops bucket (e.g. "tmnt-mmpr-iii/issue-1/page-07/page-07_b08.webp")
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  foreign key (book_id, issue_id) references issues(book_id, id),
  unique (book_id, issue_id, legacy_id)
);

create index bubbles_page   on bubbles(book_id, issue_id, page_number, sort_order);
create index bubbles_legacy on bubbles(book_id, issue_id, legacy_id);  -- for migration lookups and legacy_id resolution
```

**Stable identity design**: The UUID `id` is assigned at insert time and never changes — reordering a bubble is `UPDATE bubbles SET sort_order = 2 WHERE id = $uuid`. Audio files in Storage are named by `audio_storage_path` (not derived from `sort_order`), so no file renames occur when reading order changes.

**`legacy_id`**: Preserved from the `page-{NN}_b{NN}` positional ID scheme for human-readable logs and as the join key during initial migration. It is not a FK target anywhere — `audio_timestamps` and all other tables reference the UUID.

**`audio_storage_path`**: Existing MP3s keep their original filenames (e.g., `page-07_b08.mp3`) — no re-upload needed. Audio regenerated post-migration is named `{uuid}.mp3`. The pipeline and frontend always use this column to construct the audio CDN URL, never deriving the filename from `legacy_id` or `sort_order`.

**Why JSONB for `box_2d` and `style`**: `box_2d` has an irregular shape (sometimes `{x, y, width, height, confidence, class, cropPath}`, sometimes `{index}` for manually-added bubbles). `style` is a fixed 4-field object and could be normalized columns, but JSONB keeps the migration simple and the query patterns don't need to filter on individual style fields.

---

### Audio Timestamps

```sql
create table audio_timestamps (
  bubble_id            uuid not null references bubbles(id) on delete cascade,
  book_id              text not null,
  issue_id             text not null,
  alignment            jsonb,  -- {characters[], character_start_times_seconds[], character_end_times_seconds[]}
  normalized_alignment jsonb,
  created_at           timestamptz default now(),
  primary key (bubble_id)
);

create index audio_timestamps_issue on audio_timestamps(book_id, issue_id);
```

**Why not normalize further**: The alignment arrays are parallel float arrays with 100+ entries per bubble and are always accessed together. JSONB avoids 3+ join tables and reads just as fast for the access pattern (always fetch all timestamps for a page at once).

**`on delete cascade`**: Deleting a bubble automatically removes its timestamp row. In the positional-ID JSON world this had to be done in two places manually.

---

### Castlist

```sql
create table castlist (
  book_id    text not null,
  issue_id   text not null,
  character  text not null,
  voice_id   text not null,    -- ElevenLabs voice ID
  primary key (book_id, issue_id, character),
  foreign key (book_id, issue_id) references issues(book_id, id)
);
```

---

### Character Registry

```sql
create table characters (
  id         text primary key,   -- canonical name, e.g. "Green Ranger"
  franchise  text,
  aliases    text[] not null default '{}',  -- raw aliases array from registry
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table character_appearances (
  id              text primary key,   -- e.g. "green-ranger-voice-design"
  character_id    text not null references characters(id),
  media_title     text,
  year            int,
  voice_actor     text,
  media_type      text,               -- "pvc" | "voice_design"
  youtube_search_terms text[],
  notes           text,
  -- voice fields
  voice_id        text,               -- ElevenLabs ID
  voice_type      text,
  voice_status    text,               -- "ready" | "pending" (legacy — kept for backwards compat)
  voice_description text,
  voice_created_at timestamptz,
  -- casting browser UI fields (populated when a voice model is created via browser flow)
  clip_storage_path    text,          -- path in comic-voice-clips bucket, e.g. "green-ranger/green-ranger-mmpr.mp3"
  clip_source_url      text,          -- YouTube URL or "uploaded" if user uploaded directly
  clip_duration_secs   float,         -- validated at upload: must be >= 60s for PVC
  voice_model_status   text not null default 'pending',  -- pending | processing | ready | failed
  voice_model_error    text,          -- error message when voice_model_status = 'failed'
  voice_model_started_at timestamptz,
  created_at      timestamptz default now()
);
```

---

### Aliases

This replaces `data/alias-map.json` with a scoped table.

```sql
create type alias_scope as enum ('global', 'series', 'book');

create table aliases (
  id           serial primary key,
  alias        text not null,          -- lowercase input key, e.g. "tommy"
  canonical    text not null,          -- canonical name, e.g. "Green Ranger"
  scope        alias_scope not null default 'global',
  scope_id     text,                   -- null for global; series/book id otherwise
  created_at   timestamptz default now(),
  unique (alias, scope, scope_id)      -- one canonical per alias per scope
);

-- Lookup index
create index aliases_lookup on aliases(alias, scope, scope_id);
```

**Scope resolution order** (most specific wins):
1. Book-level alias matching `scope='book' AND scope_id=bookId`
2. Series-level alias matching `scope='series' AND scope_id=seriesId`
3. Global alias matching `scope='global'`

The `getCanonicalName()` utility in `scripts/alias-map.ts` will need to accept optional `bookId`/`seriesId` and query in this priority order.

---

### Speaker Reviews

Stores per-speaker decisions from the `review-speakers` browser UI (step 4.5). Created by the pipeline when it reaches step 4.5 in `--db` mode; read and resolved by the browser review page. Replaces the local `data/reviewed-speakers.json` file.

```sql
create table speaker_reviews (
  id            uuid primary key default gen_random_uuid(),
  book_id       text not null,
  issue_id      text not null,
  original_name text not null,    -- speaker name as Gemini wrote it ("Winged Monster")
  resolved_name text,             -- corrected name ("Goldar"); null = not yet reviewed
  status        text not null default 'pending',  -- pending | accepted | renamed | skipped
  auto_accepted boolean not null default false,   -- true if pre-accepted by registry/roster match
  save_as_alias boolean not null default false,   -- if true, also write to aliases table on completion
  alias_scope   text,                             -- 'global' | 'book' — only when save_as_alias = true
  sample_text   text,             -- first ocr_text snippet for this speaker (≤80 chars), for the UI card
  page_numbers  int[],            -- array of page numbers this speaker appears on
  bubble_count  int not null default 0,
  reviewed_at   timestamptz,
  created_at    timestamptz default now(),
  unique (book_id, issue_id, original_name),
  foreign key (book_id, issue_id) references issues(book_id, id)
);

create index speaker_reviews_pending on speaker_reviews(book_id, issue_id, status)
  where status = 'pending';
```

**Usage**: On pipeline re-run, the step checks for any `status='pending' AND auto_accepted=false` rows. If none exist, it applies all resolved renames to `bubbles` and advances. If some exist, it prints the review URL and exits with code 2.

---

### Casting Tasks

Tracks which characters need voice casting for a given issue. Created by `find-voice-sources --db` (step 9); resolved by the casting browser UI. Enables the pipeline to know when casting is complete and step 10 can run automatically.

```sql
create table casting_tasks (
  id             uuid primary key default gen_random_uuid(),
  book_id        text not null,
  issue_id       text not null,
  character_id   text not null references characters(id),
  status         text not null default 'pending',  -- pending | in_progress | complete | skipped
  created_at     timestamptz default now(),
  completed_at   timestamptz,
  unique (book_id, issue_id, character_id),
  foreign key (book_id, issue_id) references issues(book_id, id)
);

create index casting_tasks_pending on casting_tasks(book_id, issue_id, status)
  where status = 'pending';
```

**Usage**: After the casting UI marks all tasks `complete`, the pipeline re-runs from step 9 — finds 0 pending tasks — and step 10 (`generate-voice-models --from-db`) reads `clip_storage_path` from `character_appearances` to create ElevenLabs models automatically without a human pause.

---

### Pipeline Runs

Replaces `checkpoint.json` with a queryable run history. Each pipeline execution is one row; per-step state is a JSONB column.

```sql
create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  book_id      text not null,
  issue_id     text not null,
  started_at   timestamptz default now(),
  completed_at timestamptz,
  status       text not null default 'running',  -- running | done | failed
  steps        jsonb,  -- { stepName: { status, startedAt, completedAt, error } }
  foreign key (book_id, issue_id) references issues(book_id, id)
);

create index pipeline_runs_issue on pipeline_runs(book_id, issue_id, started_at desc);
```

**Migration**: No historical data to migrate — `checkpoint.json` only captures the current run. Populate going forward.

---

### Page Context

Persists the full Gemini analysis output for each page. Replaces `assets/comics/{book}/{issue}/data/gemini-context/page-{NN}.json`. Makes Gemini context available to cloud pipeline steps and queryable for debugging ("why did Gemini assign this speaker?").

```sql
create table page_context (
  book_id      text not null,
  issue_id     text not null,
  page_number  int not null,
  gemini_model text,
  raw_response jsonb,   -- full structured Gemini output (speaker assignments, emotion, narrative context)
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  primary key (book_id, issue_id, page_number),
  foreign key (book_id, issue_id) references issues(book_id, id)
);
```

**Migration**: Optionally migrate existing `gemini-context/page-{NN}.json` files during initial setup. If the files don't exist locally (they're gitignored), leave the table empty — it populates on the next pipeline run.

**Phase D integration**: The `get-context` step (step 4) should upsert into `page_context` after each page. This makes re-runs idempotent and skippable when the context already exists (same model, same page).

---

## Migration Script

Add `scripts/migrate-to-db.ts`:

```typescript
// Usage: pnpm migrate-to-db -- --book tmnt-mmpr-iii --issue 1
// Or:    pnpm migrate-to-db -- --all   (migrates all issues found in assets/)
//
// Reads local JSON files and upserts into Supabase.
// Idempotent — safe to re-run.
```

**Migration order** (respects FK constraints):
1. Upsert `books` row
2. Upsert `issues` row
3. Upsert `pages` rows from `pages.json`
4. Insert `bubbles` rows from `bubbles.json` — build `legacyIdToUuid: Map<string, string>` as you go
5. Upsert `audio_timestamps` rows from `audio-timestamps.json` — resolve bubble UUID via `legacyIdToUuid`
6. Upsert `castlist` rows from `castlist.json`
7. Upsert `characters` + `character_appearances` from `data/character-registry.json`
8. Upsert `aliases` from `data/alias-map.json` (all as `scope='global'`)
9. *(Optional)* Upsert `page_context` rows from `data/gemini-context/page-{NN}.json` if the directory exists

**Bubble flattening and legacy_id mapping**:

```typescript
const legacyIdToUuid = new Map<string, string>();

for (const [pageKey, bubbles] of Object.entries(bubblesJson)) {
  const pageNumber = parseInt(pageKey.match(/page-(\d+)/)?.[1] ?? '0');
  for (const [sortIndex, bubble] of bubbles.entries()) {
    const row = {
      // id: omit — Supabase assigns uuid
      legacy_id:          bubble.id,            // "page-07_b08"
      book_id:            bookId,
      issue_id:           issueId,
      page_number:        pageNumber,
      sort_order:         sortIndex,
      audio_storage_path: `${bubble.id}.mp3`,   // preserve original filename; no re-upload needed
      // ... all other fields
    };
    const { data } = await supabase.from('bubbles').insert(row).select('id').single();
    legacyIdToUuid.set(bubble.id, data.id);
  }
}
```

**audio_timestamps migration** — resolve UUID via the map built above:

```typescript
for (const [legacyId, tsData] of Object.entries(audioTimestampsJson)) {
  const uuid = legacyIdToUuid.get(legacyId);
  if (!uuid) {
    console.warn(`No bubble found for legacy ID ${legacyId} — skipping timestamp`);
    continue;
  }
  await supabase.from('audio_timestamps').upsert({
    bubble_id:            uuid,
    book_id:              bookId,
    issue_id:             issueId,
    alignment:            tsData.alignment,
    normalized_alignment: tsData.normalizedAlignment ?? null,
  });
}
```

**audio_storage_path convention**:
- **Migrated bubbles**: `audio_storage_path = "{legacy_id}.mp3"` (e.g., `page-07_b08.mp3`). The MP3 already exists in Storage under this name — no rename, no re-upload.
- **New bubbles** (inserted post-migration): `audio_storage_path = "{uuid}.mp3"`. Set when `generate-audio` writes the file.
- The pipeline and frontend always derive the audio CDN URL from this column, never from `legacy_id` or `sort_order`.

**Idempotency**: Use Supabase's `.upsert()` with `onConflict` for pages, castlist, aliases, and characters. For bubbles, a full delete-and-reinsert per issue is safe (UUID assignment is stable on re-run only if you first check for existing rows via `legacy_id`). Recommended: on re-run, `SELECT id FROM bubbles WHERE legacy_id = $x` to reuse the existing UUID instead of minting a new one.

---

## Row-Level Security (RLS)

For a personal family app, keep it simple:

- **Public read** on `books`, `issues`, `pages`, `bubbles`, `audio_timestamps`, `castlist`, `characters`, `character_appearances`, `aliases` — the app is read-only for end users.
- **No writes from the browser** in Phase B/C. Writes happen via service role key from scripts.
- In Phase E, if direct browser writes are added for the review flow, add a write policy gated on a `SUPABASE_REVIEW_SECRET` environment variable or JWT role.

```sql
-- Enable RLS on all tables
alter table books enable row level security;
-- ... repeat for all tables

-- Public read
create policy "public read" on books for select using (true);
-- ... repeat for all tables
```

---

## Checklist

- [ ] Write and apply SQL migrations (use Supabase dashboard SQL editor or `supabase db push`)
- [ ] Write `scripts/migrate-to-db.ts` with `legacyIdToUuid` map for audio_timestamps
- [ ] Add `migrate-to-db` to `package.json` scripts
- [ ] Migrate existing issue(s) as smoke test
- [ ] Verify row counts match JSON file contents
- [ ] Verify `audio_storage_path` matches existing MP3 filenames in Storage
- [ ] Verify `audio_timestamps` rows reference correct UUID (join against `bubbles.legacy_id` to confirm)
- [ ] Migrate `alias-map.json` entries as global scope
- [ ] Migrate `character-registry.json`
- [ ] Create `pipeline_runs` and `page_context` tables
- [ ] Create `speaker_reviews` table
- [ ] Create `casting_tasks` table
- [ ] *(Optional)* Migrate existing `gemini-context/` files into `page_context`
- [ ] Enable RLS with public read policies on all tables (including `speaker_reviews`, `casting_tasks`)
