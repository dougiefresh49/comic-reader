# Feature: Casting Browser UI

## Status: `done`

---

## Purpose

The casting browser UI replaces the terminal-based voice sourcing workflow with a two-phase browser flow:

1. **Triage phase** — User selects which characters to research. Wiki-sourced voice actor hints are shown for free (parsed from `issues.wiki_appearances`). Users check characters they want Gemini to research and can bulk-skip or bulk-Voice Design the rest.

2. **Cast phase** — Researched characters show Gemini suggestion cards with YouTube search links, voice actor info, and media appearance details. User sources clips locally, creates an ElevenLabs IVC voice, and pastes the voice ID. Or uses Voice Design for minor characters.

Research is **on-demand** — Gemini is only called for characters the user selects, not all characters upfront. This saves API calls and lets users skip research for characters they don't need custom voices for.

---

## How It Works

### Pipeline Integration

`find-voice-sources --db` (step 14 of the pipeline):
1. Creates `characters` rows for new characters
2. Creates `casting_tasks` rows (one per character needing a voice)
3. Writes any cached appearances from the local registry
4. Pauses the pipeline (`exit 2`) with URL to the casting UI
5. Does **NOT** call Gemini — research is deferred to the browser

### Browser Flow

```
/admin/characters/casting?book={bookId}&issue={issueId}
```

**Phase 1 — Triage (unresearched characters):**
- Checkbox list of characters needing casting
- Wiki voice hints shown in amber (e.g., "Wiki: voiced by Kerrigan Mahan")
- "Research Selected" button → triggers Gemini per character (on-demand)
- "Voice Design Selected" button → bulk creates voices from text descriptions
- "Skip" per character → marks as silent, can revisit later

**Phase 2 — Cast (researched characters):**
- Gemini suggestion cards with media appearances
- YouTube search links per appearance
- "Mark as my source" → bookkeeping for which clip the IVC came from
- Voice ID paste → saves to castlist and marks task complete
- "Voice Design" → generates voice from text description
- "Skip" → marks as silent

**Complete Casting:**
- Appears when all tasks are complete or skipped
- Clears `pipeline_paused` flag on the issue
- User resumes pipeline with `pnpm ingest`

---

## Schema

### `casting_tasks` table

```sql
CREATE TABLE casting_tasks (
  id             uuid primary key default gen_random_uuid(),
  book_id        text not null,
  issue_id       text not null,
  character_id   text not null references characters(id),
  status         text not null default 'pending',
  created_at     timestamptz default now(),
  completed_at   timestamptz,
  UNIQUE (book_id, issue_id, character_id)
);
```

### `character_appearances` columns used

- `voice_model_status`: `pending` | `processing` | `ready` | `failed`
- `voice_model_started_at`: when source was marked
- Standard fields: `media_title`, `year`, `voice_actor`, `media_type`, `youtube_search_terms`, `notes`

---

## Server Actions (`actions.ts`)

| Action | Purpose |
|--------|---------|
| `saveVoiceId` | Save pasted ElevenLabs voice ID → castlist + mark task complete |
| `skipAndAddLater` | Write `__SKIPPED__` sentinel → castlist, mark task skipped |
| `markChosenSource` | Bookkeeping: which appearance the user chose as clip source |
| `createVoiceDesign` | ElevenLabs Voice Design API (text → generated voice) → save |
| `bulkVoiceDesign` | Batch Voice Design for multiple characters |
| `researchCharacter` | On-demand Gemini research for a single character |
| `completeCasting` | Clear pipeline pause, validate no pending tasks remain |

---

## Files

| File | Purpose |
|------|---------|
| `src/app/admin/characters/casting/page.tsx` | Server page — fetches tasks, renders layout |
| `src/app/admin/characters/casting/CastingClient.tsx` | Client component — two-phase triage + cast UI |
| `src/app/admin/characters/casting/actions.ts` | Server actions |
| `src/server/admin/casting.ts` | Data queries — `getCastingTasks()` with wiki hints |
| `scripts/find-voice-sources.ts` | Pipeline step — `--db` mode creates tasks without research |

---

## Verification

```bash
# 1. Run pipeline to step 14:
pnpm ingest -- --book <name> --issue <n>
# → casting_tasks created, pipeline pauses

# 2. Open /admin/characters/casting?book=<name>&issue=issue-<n>
# - Phase 1: triage view with checkboxes + wiki hints
# - Select characters → "Research Selected" → Gemini runs per character
# - Phase 2: suggestion cards with YouTube links
# - Paste voice IDs or use Voice Design

# 3. Click "Complete Casting" → pipeline unpaused

# 4. Resume: pnpm ingest -- --book <name> --issue <n>

pnpm typecheck
```
