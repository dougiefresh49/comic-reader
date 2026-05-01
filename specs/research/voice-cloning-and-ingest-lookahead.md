# Voice cloning ceiling + ingest "lookahead" — analysis

Two adjacent problems, considered together because the second one (better
character/context detection) feeds the first one (knowing which voices we
actually need to keep "hot" at a given moment).

---

## TL;DR

- **The 30-IVC ceiling is a production-time constraint, not a runtime
  constraint.** Once a book's audio is generated, the IVC slot is no
  longer load-bearing — every bubble's mp3 is already rendered to
  storage. The slot is only needed while we're (a) cutting new bubbles
  for that book or (b) re-rolling takes during fixes.
- The right primitive is **archive-and-restore**: snapshot the source
  clip + voice settings, delete the IVC, re-create from the snapshot
  later if we need to regenerate. Stay on Creator. Don't pay for Pro
  capacity we mostly don't need.
- Stable internal IDs solve the "ElevenLabs ID changes on recreate"
  problem. Add a thin `voices` table; characters FK to that, not to the
  raw EL id.
- For *one-off* characters (random screaming bystander), don't burn an
  IVC slot at all — use a **shared library voice** from ElevenLabs.
  Those don't count against the cap.
- Of the lookahead ingest ideas, the highest-leverage one is
  **whole-issue face detection + clustering before per-page Gemini
  analysis**. Wiki API ingestion is worth doing because it's cheap.
  RAG is premature unless we build the kid-facing "Ask" feature.

---

## Part 1 — The IVC ceiling

### What ElevenLabs actually charges you for

A few facts worth pinning down before evaluating the four options:

1. **IVCs consume a slot only while they exist.** Delete the voice → slot
   freed. There is no per-character monthly fee.
2. **Generated audio persists independently.** mp3s we've already rendered
   to Supabase Storage keep working forever, even if the IVC behind them
   is deleted tomorrow.
3. **No "archive" / hibernate state.** ElevenLabs removed soft-archive a
   while back. The only states are "exists, counts against cap" and
   "deleted." So option (2) in your list — archive in EL — isn't on the
   menu. We have to simulate archive on our side.
4. **IVCs are mostly deterministic but not exactly identical on
   recreation.** Same source clip + same settings + same model usually
   produces an effectively-identical voice; there can be micro-timbre
   differences across recreations or model upgrades. Practical
   implication below.
5. **Library / shared voices are free against the cap.** If we add a
   community voice to our project, it doesn't count against 30. This is
   the trapdoor for one-offs.
6. **Voice Design** outputs are saved as IVC slots, but the *prompt* that
   produced them is reproducible — store the prompt and we can recreate
   the voice on demand the same way as a clip-cloned IVC.

### Re-evaluating your four options

**(1) Multiple Creator accounts.** Walks back the cost savings (5×
Creator ≈ $110/mo, basically Pro money) and introduces credential
juggling, ToS gray area on multi-account use, and split history. Skip.

**(2) Archive in EL.** Not a real product feature. Skip.

**(3) Snapshot + delete + recreate.** This is the right answer. Detail
below.

**(4) Upgrade to Pro.** $99/mo for capacity we'd use for ~1 month of
ingest per book. Bad ROI unless we're publishing multiple new universes
in parallel and are willing to pay for the speed. Reasonable as a
*temporary* upgrade for a heavy ingest sprint, then drop back. Don't
adopt it as the default.

### Recommended approach: archive-and-restore

The mental shift: IVCs are a **production-time resource**, similar to a
tracked-changes branch. We "check out" voices when working on a book,
and "check them back in" (delete on EL, snapshot on our side) when the
book ships.

The minimum viable version:

1. **Snapshot** every IVC at create time:
   - source clip(s) (already on disk under `assets/.../voice-clips/`)
   - voice settings (stability, similarity, style)
   - voice name + EL id at time of creation
   - (for Voice Design voices) the design prompt
2. **Delete** the IVC from ElevenLabs after a book finishes ingest +
   audio generation.
3. **Restore** by re-uploading the source clip / re-running Voice Design
   if we ever need to regenerate audio for that book — this creates a
   *new* EL id, but the timbre is effectively the same.

Where the IDs touch our system:

- `castlist.json` per issue currently maps character → EL voice id.
- That id is consulted only at audio-generation time. After audio is
  generated, the id is dead-weight metadata.
- So we can let it go stale after archive. On restore, we update the row
  with the new id and regenerate.

To make that bookkeeping less painful, introduce a **stable internal id**:

```sql
create table voices (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  series_id text,                   -- nullable; library voices may be cross-series
  status text not null              -- 'active' | 'archived' | 'library'
    check (status in ('active','archived','library')),
  current_elevenlabs_id text,       -- null when archived
  voice_settings jsonb,
  source_clip_path text,            -- storage path to training audio
  design_prompt text,               -- for Voice Design voices
  created_at timestamptz default now(),
  archived_at timestamptz
);

-- characters reference voices by our stable id
alter table characters add column voice_id uuid references voices(id);
```

`current_elevenlabs_id` rotates freely. Everything else stays put. The
generate-audio script's contract becomes:

```
for each character used in this book:
  v = voices.find(...)
  if v.status == 'archived':
    restore(v)            # uploads clip → new EL id → status='active'
  use v.current_elevenlabs_id for TTS
```

This collapses your option 3 into something concrete and gives us an
"archive a finished book's voices" CLI command:

```
pnpm rotate-book -- --book tmnt-mmpr-iii --archive
pnpm rotate-book -- --book dc-x-sonic    --restore
```

### One important caveat: don't archive mid-book

Recreated IVCs have small timbre drift. If we archive a book, then later
realize we need to fix one bubble in that book, the regenerated bubble
will be subtly off from the rest of the book. Three responses:

- **Cheap:** accept it for a single bubble; nobody will notice.
- **Medium:** mark a book as "archived; minor fixes only" and refuse
  regenerate-all on archived books.
- **Strong:** keep voices live for N days post-publish to absorb the
  bug-fix tail, then archive. Maybe a `rotate-book --archive-after 14d`
  flag enforced by a cron.

I'd start with cheap and only escalate if we hit it in practice.

### One-off characters

For a character with one or two lines in one issue, an IVC is wasted
capacity. Two routes:

- **Library voice.** ElevenLabs ships thousands of community-shared
  voices. Adding them to our project does not consume an IVC slot. We
  can pick one programmatically by querying the library by tags
  (gender, age, accent) and pinning the chosen `voice_id` in the
  characters table. Mark `voices.status = 'library'` so the rotation
  scripts leave it alone.
- **Voice Design with no clip.** Generates a voice from a text prompt.
  Still consumes an IVC slot, but we can archive immediately after the
  audio is rendered.

Recommend library-first; fall back to Voice Design only if no library
voice is close enough. The selection step lives in the existing
`find-voice-sources` step (Phase 4).

### What this looks like in numbers

Assume each new book/issue needs ~15 distinct voices:

- **TMNT main cast (Leo, Raph, Donnie, Mikey, Splinter, etc.)** — 8 PVCs
  / IVCs we want to keep "live" forever because we'll keep adding TMNT
  issues.
- **MMPR main cast** — same, ~6.
- **One-off villains / bystanders** — library voices, free.

So our 30-slot Creator cap can sustain roughly: ~14 "permanent" main-cast
voices across 2–3 active series + ~16 ephemeral slots for whoever's
currently being ingested. When we open DC × Sonic: archive the TMNT
secondary cast (anyone not in the next planned issue), generate the new
DC × Sonic voices, then archive *those* when ingest finishes. Stay on
Creator indefinitely.

---

## Part 2 — The lookahead ingest pipeline

The voice problem and the character-detection problem rhyme: both get
easier if we know *up front* who's in a book before we start
page-by-page processing.

Today, the pipeline does per-page detection: Roboflow finds bubbles,
Gemini guesses the speaker for each bubble using only the page image
plus a thin slice of context. That's why we hit "who is this random
character on page 22" guesses that mangle the data.

The proposed lookahead step has three sub-ideas. Ranked by leverage:

### Highest leverage: face detection + clustering across the whole issue

This is the genuinely new capability. Train a Roboflow model that does
*one job*: bound character faces. Run it across all pages in a single
batch before any Gemini work happens. Then:

1. Crop every detected face → save with `(page, panel, bbox)` reference.
2. **Cluster** faces (same character across pages). This is the hard
   part. Two viable approaches:
   - **Embed each face** with CLIP or a face-recognition model →
     cluster by cosine distance. More work to set up; produces stable,
     reusable embeddings (which we'd want anyway for the character
     registry).
   - **Compose a contact-sheet image** of all face crops → ask Gemini
     "group these and label". Faster to implement; quality depends on
     Gemini being able to follow the "group" instruction at scale. Fine
     for ~50 faces; may degrade past ~150.
3. **Identify each cluster** by name, using the wiki "Appearances" list
   for this issue + the series character-profile sheet as context. One
   identification call per cluster, not per panel. Cluster size = N
   panels × M faces collapses to K characters.
4. Persist `(page, panel, character_id)` rows. Now the speaker-ID step
   in the existing pipeline becomes "for each bubble, find the closest
   face crop" — a geometry problem, not a vision problem.

Why this is high leverage:
- Per-character calls scale O(K) instead of O(panels), which keeps
  costs flat as books get longer.
- Each cluster has more "signal" (multiple poses + angles) than any
  single panel crop, so Gemini's identification is materially better.
- The face crops naturally double as the **headshot reference for the
  character registry** and as input for the voice-sourcing step ("who
  is this on screen, what should they sound like").
- The known failure mode (Gemini hallucinating speakers from a single
  panel) goes away because the speaker label is stamped issue-wide.

The Roboflow training cost is real but bounded — your panel model took
30 min, faces are an easier shape — and unlike Gemini calls, it's a
one-time cost.

### Medium leverage: wiki API ingestion

The MediaWiki / Fandom API works fine; no agentic scraping needed for
basic data. The note from Gemini in `specs/research/wiki-api/` is
correct on the API endpoint. For each book/issue:

```
GET https://<wiki>.fandom.com/api.php?action=parse
  &page=<title>
  &format=json
  &prop=text|sections
```

Pull the **Summary** and **Appearances** sections. Save them raw under
`assets/comics/<book>/issue-<n>/data/wiki/`. Feed both into the existing
Gemini context calls.

Things to build *now*:
- A `fetch-wiki-context` ingest step (slot it before `get-context`).
- Per-series config that names the wiki host + the title-resolution
  pattern (e.g. `tmnt: "Teenage_Mutant_Ninja_Turtles_({series})_Issue_{n}"`).
- A graceful "no wiki page found" fallback that still lets ingest
  proceed.

Things to **not** build yet:
- pgvector / RAG pipeline. RAG only pays off when we have a
  user-facing "Ask" feature consuming it. Until then, the right form of
  the wiki data is *raw text in the prompt*, not embeddings. Adding
  pgvector now is build-cost without a payoff feature.
- Local embedding via Transformers.js. Same reason.

The structure of fandom wikis is uneven — some issue pages have
detailed Appearances lists, others have nothing. Worst case, we have a
no-op step that occasionally helps a lot. That's fine.

### Lower leverage (but cheap): per-series character profiles

This one is mostly already in flight as `specs/features/character-registry.md`.
The variant of it that matters here is the **per-series** scoping you
called out: Raphael in TMNT-2003-cartoon-style is a different character
from Raphael in TMNT-IDW-grim-style, voice-wise and personality-wise.
The schema needs a series dimension:

```
character_profiles
  id, character_id, series_id,
  name_in_series, description, personality, headshot_url,
  voice_id  -- FK to voices(id) above
```

`character_id` is the canonical "Raphael," `series_id` differentiates
visual + tonal variants, and `voice_id` decouples voice assignment from
either. The face-clustering step writes headshots into this table.

### A reasonable phasing

Don't try to do all of this in one swing. Suggested order:

1. **Voice rotation** (Part 1). Smallest blast radius, biggest near-term
   pain. Unblocks adding the next book on Creator.
2. **Wiki API context fetch.** Single new ingest step, immediate
   improvement to existing Gemini calls, no schema work.
3. **Per-series character profiles + headshot column.** Plumbing for
   step 4. Mostly a schema change + admin UI tweak.
4. **Roboflow face detection + clustering.** The big rework. Replaces
   per-bubble speaker guessing with cluster-stamped identity. Land it
   alongside a backfill script to re-run on existing books and audit
   accuracy improvements.
5. **(Maybe later) RAG / "Ask" feature.** Only when there's a kid-facing
   reason to embed.

---

## Open questions / things to verify before building

These are the spots where I'd want a quick test before committing to
the design above:

- **IVC recreation fidelity.** Generate audio with an IVC, delete it,
  recreate from the same clip, generate the same line, A/B listen.
  If it's audibly different we need to keep main-cast voices live
  permanently and only rotate secondaries.
- **Library voice variety per character archetype.** Spot-check that we
  can find acceptable library voices for typical one-off needs ("scared
  child," "gruff guard," "panicked woman"). If the library is
  consistently weak, we lean on Voice Design instead.
- **Roboflow face detection on stylized comic art.** Faces are stylized
  per artist; a face detector trained on photos won't transfer. Plan on
  training from scratch on 50–100 labeled pages from the actual books we
  ingest.
- **Wiki coverage for the universes we're targeting next.** TMNT and
  MMPR have strong Fandom presence. Sonic and DC do too. Niche indie
  books may not — worth a five-minute look before committing.
