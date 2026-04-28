# Cleanup Follow-ups

Things that have gone vestigial during the data-migration phases. None
of these block features; they're tidiness. Tackle on a quiet day.

---

## 1. `markChosenSource` server action + the `voice_model_status='processing'` flow

`src/app/admin/characters/casting/actions.ts` exports `markChosenSource`,
which flips `character_appearances.voice_model_status` from `pending` to
`processing` when the user clicks "Mark as my source." This was carried
over from the original PVC plan where a worker was meant to watch for
`processing` rows and run yt-dlp + ElevenLabs creation server-side.

Now that the casting flow is "user does it locally and pastes the voice
ID," nothing watches the `processing` state. The button is purely visual.

Options:
- Keep as-is — the visual cue ("you said you'd use this one") is still
  useful even without a worker.
- Drop the action and the column write entirely — simpler.
- Repurpose: rename to `markIntendedSource`, store as a separate
  bookkeeping field (e.g. `character_appearances.user_picked_at`)
  instead of overloading `voice_model_status`.

Recommendation: drop the action, replace the in-card highlight with
local component state only (already half there — `chosenAppearanceId`
in `CharacterCard` is local state).

## 2. `scripts/apply-fixes.ts` is mostly duplicated by `/api/apply-fixes`

The terminal script and the API route do the same DB-write logic with
different transports. The script still has value for offline batch
runs (export `fixes.json`, hand-edit, apply), but the duplicated logic
will drift.

Options:
- Extract the shared logic into `scripts/lib/apply-fixes-core.ts`,
  import from both. Cleanest.
- Delete the terminal script — make `pnpm apply-fixes` shell out to
  `curl -X POST` against the deployed `/api/apply-fixes`. Coupling
  to the production URL is a wart, dev-vs-prod ambiguous.
- Leave it. Drift risk is small as long as fixes.json schema is stable.

Recommendation: extract shared core when either side gets a non-trivial
change. Until then, leave it.

## 3. `voice_status` vs `voice_model_status` drift on `character_appearances`

Two columns now hold related state:
- `voice_status` (string) — original from Phase B, free-form values
  like `"ready"`, `"needs_clips"`, `"needs_model"`
- `voice_model_status` (string, default `"pending"`) — added later,
  values `"pending"`, `"processing"`, `"ready"`, `"failed"`

The casting flow writes both today (sets both to `"ready"` when a
voice ID is saved). Various readers check one or the other.

Options:
- Pick `voice_model_status` as canonical, deprecate `voice_status`,
  drop the column after a release. Migration script needed if any
  consumer still reads the old column.
- Define the difference: `voice_status` describes the *current* voice
  reference state; `voice_model_status` describes the *creation*
  progress. Document, leave both.

Recommendation: collapse into `voice_model_status`. A few-line
migration + grep+replace.

## 4. `pageImageUrl` is the only thing that knows the bucket layout

`src/lib/storage.ts` builds the public URL from `bookId/issueId/page-NN`.
It's fine, but the casting / new-issue flows hardcode similar patterns
(`${bookId}/${issueId}/source/page-NN.jpg` for raw uploads,
`${bookId}/${issueId}/${storagePath}` for audio).

Recommendation: add `comicAudioPath()`, `rawPagePath()`, `cropPath()`
helpers next to `pageImageUrl` so all bucket paths live in one file.
Small, do when you next touch storage.

## 5. `OVERNIGHT_NOTES.md` should probably move

Living at the repo root. It's served its purpose; could move to
`specs/notes/2026-04-overnight.md` or be deleted once the PR merges.

## 6. `scripts/apply-fixes.ts` `STORAGE_MODE=local` branch

The script supports `STORAGE_MODE=local|supabase|both`, but post Phase D
the canonical mode is `supabase`. The `local` and `both` branches are
maintained mostly as transition support. Once issue 3 is fully migrated
and there are no more local-only consumers, delete the local-mode
branches.
