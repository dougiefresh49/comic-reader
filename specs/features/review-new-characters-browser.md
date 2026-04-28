# Review New Characters — Browser UI

## Status: `pending`
## Pattern source: mirrors `review-speakers-browser.md` and the shipped speakers review UI almost exactly
## Implementer: Cursor agent (this is a delegated implementation)

---

## Goal

Replace the terminal-only `pnpm review-new-characters` step (interactive readline) with a browser flow that lives at:

```
/admin/[bookId]/[issueId]/review/new-characters
```

After this lands, the entire pipeline review surface is in the browser except for the rare external tools (yt-dlp, ElevenLabs IVC creation). The terminal script stays usable as a fallback but is no longer the default.

---

## Background — what review-new-characters does today

Position: pipeline step 10 (between `clean-voice-descriptions` and `find-voice-sources`).

Behavior of `scripts/review-new-characters.ts`:
1. Load `bubbles.json` → collect speaker set (alias-resolved)
2. Load `new-characters.json` (output of clean-voice-descriptions) and `known-characters.json`
3. **Prune:** drop any new-character entry whose alias-resolved name doesn't appear in the actual bubbles speaker set (handles stale data from re-runs)
4. For each remaining "new" character:
   - Show `[1] new — research appearances` (default)
   - OR `[2] alias to existing character`
   - If alias: pick from confirmed-so-far list, or type a free-text name
5. New aliases are written **immediately** to `data/alias-map.json` and (recently) the DB `aliases` table
6. The script may merge / promote-to-known characters as aliases collapse them
7. Final list goes to `find-voice-sources` for Gemini research

The data lifecycle is: `bubbles.json` (canonical speakers) → `new-characters.json` (per-issue working set) → `aliases` (persistent) → `find-voice-sources` (next step).

---

## The web flow

### Live derivation (no new table)

Mirroring the speakers refactor: **don't add a `new_character_reviews` table.** Derive the queue live from existing data on every page load:

```ts
async function getNewCharacterReviews(bookId: string, issueId: string) {
  // 1. Distinct (alias-resolved) speakers from this issue's bubbles
  const speakerSet = new Set<string>();
  // SELECT DISTINCT speaker FROM bubbles
  //   WHERE book_id=? AND issue_id=? AND speaker IS NOT NULL AND ignored = false
  //   AND type IN ('SPEECH','NARRATION','CAPTION');
  // Apply alias resolution against `aliases` (global + book-scoped)

  // 2. For each speaker:
  //    - Skip if already in the global `characters` registry with a ready voice
  //    - Skip if already in `castlist` for this issue (means already resolved + cast)
  //    - Skip if its alias-resolved canonical name == "Narrator" (auto-routed)
  //    - Otherwise: it's a "new character" candidate

  // 3. Build per-character context (page numbers, bubble count, sample text)
  //    so the UI shows where they appear
}
```

Output type:

```ts
interface NewCharacterReview {
  /** Original speaker string from bubbles (pre-alias-resolution) */
  originalName: string;
  /** Alias-resolved name (== originalName if no alias). Pivot for grouping. */
  resolvedName: string;
  /** "named" or "generic" — same heuristic as scripts/review-new-characters.ts isNamed() */
  classification: "named" | "generic";
  /** Where this speaker appears */
  pageNumbers: number[];
  bubbleCount: number;
  /** Single representative line for context */
  sampleText: string | null;
  /** Persisted decision so reloads remember user choices.
   *  Persistence path: when user picks "alias to existing", write the alias row
   *  immediately and the character disappears from the queue on next refresh.
   *  When user picks "keep as new", we don't need persistence — they're already
   *  in bubbles as-is and find-voice-sources will pick them up. */
  status: "pending" | "kept_as_new" | "aliased";
  resolvedTo: string | null; // populated when aliased
}
```

The "kept as new" status is essentially a no-op — it doesn't change DB state, it just records that the user reviewed and accepted. We can derive this from "this character is in bubbles but has no alias row pointing at it AND no entry in `castlist` yet" — i.e., the queue is "everyone not yet aliased and not yet cast." Once `find-voice-sources` runs and casting happens, they leave the queue naturally.

So the simplest semantics: **the queue lists characters needing review, period.** Aliasing makes them disappear from the queue (alias row written). Keeping-as-new keeps them in the bubbles unchanged and they flow to the next pipeline step.

If the user wants to mark "I've reviewed this and decided to keep" without aliasing, we can add a small `reviewed_new_characters` table later; for v1, just mirror the script's behavior — no need to track "I considered and accepted."

### Page layout

```
Header: "Review New Characters — TMNT × MMPR III / Issue 1"
        Status: 12 of 18 reviewed   [Skip pipeline pause]

Auto-resolved (collapsed details, count badge): the characters
already aliased, registered with ready voices, or in the issue's
castlist. Read-only summary chips.

Review queue:
┌────────────────────────────────────────────────────────────────────────┐
│ "Winged Monster"                       Pages: 8, 9 (3 bubbles) [named] │
│ Sample: "HA HA, FOOL! THEY WON'T MAKE IT IN--"                          │
│                                                                          │
│ [Keep as new — research appearances]   [Alias to existing ▾]            │
└────────────────────────────────────────────────────────────────────────┘

Resolved (collapsed): things the user already aliased this session.
Each row: "Winged Monster → Goldar"   [undo]
```

The UI is a near-clone of the speakers review page:
- Three sections: auto-resolved / queue / resolved
- Per-card actions matching the spec script's [1]/[2] choices
- "Alias to existing" opens a typeahead over the union of:
  1. characters in this issue's castlist (already-cast in this issue)
  2. characters in the global `characters` registry
  3. free-text input

When the user picks an alias target:
- Server action upserts a row in `aliases` (alias = originalName.lower(), canonical = chosen target, scope = book by default with a global toggle)
- ALSO updates `bubbles.speaker` for every bubble in this issue where speaker = originalName, sets `needs_audio = true` for those bubbles, and revalidates the reader page
- That parallels the speakers UI's "Complete review" behavior, but applied per-card immediately rather than batched at the end (because new-character review has no batch step — it's eager)

### Pipeline pause + resume

The browser flow is the equivalent of the script's interactive prompt. To make ingest pause-and-resume cleanly, add a `--db` mode to `scripts/review-new-characters.ts` that:

1. Computes the same queue logic in TypeScript and counts pending review items
2. If pending > 0:
   ```
   ── Review new characters ──────────────────────────────
     7 character(s) awaiting review.
     Open: /admin/<bookId>/<issueId>/review/new-characters
     Re-run after completing review to continue.
   ────────────────────────────────────────────────────────
   ```
   And exits with code 2.
3. If pending == 0: exits 0, lets the pipeline continue.

The existing interactive code stays — it's the fallback when STORAGE_MODE != 'supabase' or when the user explicitly wants the terminal flow. The `--db` flag controls which path runs; `ingest.ts` defaults to `--db` when STORAGE_MODE is 'supabase'.

### Updates to `ingest.ts`

The pipeline step entry for `review-new-characters` should set `pipeline_paused=true` + `pipeline_paused_url='/admin/<bookId>/<issueId>/review/new-characters'` on the `issues` row when the script exits with code 2 (matching the existing pattern for review-speakers + find-voice-sources).

---

## Files to create

```
src/app/admin/[bookId]/[issueId]/review/new-characters/page.tsx
src/app/admin/[bookId]/[issueId]/review/new-characters/NewCharactersReviewClient.tsx
src/app/admin/[bookId]/[issueId]/review/new-characters/actions.ts
src/server/admin/new-characters.ts
```

Mirror the speakers triplet:
- Page = server component, fetches `getNewCharacterReviews(bookId, issueId)`, renders client
- Client = useState/useTransition, three sections, card components
- Actions = `aliasNewCharacter`, `undoAliasNewCharacter`
- Server query = `getNewCharacterReviews`, plus shared `getKnownCharactersForIssue` already exists in `src/server/admin/speakers.ts` (reuse it)

## Files to modify

- `scripts/review-new-characters.ts` — add `--db` flag with the count-and-pause behavior described above. Keep the interactive readline as the default for backward compat; activate `--db` when flag is passed.
- `scripts/ingest.ts` — when STORAGE_MODE is 'supabase' (or unconditionally for now, simpler), call review-new-characters with `--db`. When the script exits with code 2, set the issue's pause flags.

## Files NOT to touch

Stay out of these — there's parallel work happening:

- `specs/features/motion-comic-plus/*`
- `scripts/utils/shot-planner.ts` and the `plan-shots` step in `generate-episode.ts`
- `scripts/utils/panel-director.ts` if it appears (new file, parallel work)
- New panel-related migrations / `panels` table (parallel work)

---

## Server actions

```ts
// src/app/admin/[bookId]/[issueId]/review/new-characters/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "~/lib/supabase-admin";

export async function aliasNewCharacter(args: {
  bookId: string;
  issueId: string;
  originalName: string;
  canonicalName: string;
  scope: "global" | "book";
}) {
  // 1. Upsert aliases row
  await supabaseAdmin.from("aliases").upsert(
    {
      alias: args.originalName.toLowerCase().trim(),
      canonical: args.canonicalName,
      scope: args.scope,
      scope_id: args.scope === "book" ? args.bookId : null,
    },
    { onConflict: "alias,scope,scope_id" },
  );

  // 2. Update bubbles in this issue: rename speaker + flag for re-audio
  await supabaseAdmin
    .from("bubbles")
    .update({
      speaker: args.canonicalName,
      needs_audio: true,
      updated_at: new Date().toISOString(),
    })
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("speaker", args.originalName);

  // 3. Revalidate
  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );
  revalidatePath(`/book/${args.bookId}/${args.issueId}/review`, "page");
  revalidatePath(`/book/${args.bookId}/${args.issueId}`, "page");

  return { ok: true };
}

export async function undoAliasNewCharacter(args: {
  bookId: string;
  issueId: string;
  originalName: string;
  canonicalName: string;
  scope: "global" | "book";
}) {
  // 1. Delete the alias row
  let q = supabaseAdmin
    .from("aliases")
    .delete()
    .eq("alias", args.originalName.toLowerCase().trim())
    .eq("scope", args.scope);
  q =
    args.scope === "book"
      ? q.eq("scope_id", args.bookId)
      : q.is("scope_id", null);
  await q;

  // 2. Revert bubbles' speaker rename
  await supabaseAdmin
    .from("bubbles")
    .update({
      speaker: args.originalName,
      needs_audio: true,
      updated_at: new Date().toISOString(),
    })
    .eq("book_id", args.bookId)
    .eq("issue_id", args.issueId)
    .eq("speaker", args.canonicalName);

  revalidatePath(
    `/admin/${args.bookId}/${args.issueId}/review/new-characters`,
    "page",
  );
  return { ok: true };
}
```

The undo path doesn't perfectly restore the world (other bubbles might have legitimately had `speaker=canonicalName` before — we'd recklessly rename them too). This is acceptable for v1; an undo immediately after alias is the only realistic use case. If needed later, snapshot the affected bubble UUIDs in a temp table or in a server-action return value and only revert those.

---

## Acceptance test

1. Start with TMNT × MMPR III / issue 1 in a state where some unknown characters exist (re-run `clean-voice-descriptions` if needed)
2. Visit `/admin/tmnt-mmpr-iii/issue-1/review/new-characters`
3. Verify the queue lists characters that aren't already in castlist or the registry
4. Click "Alias to existing" on a card → typeahead shows known characters → pick one → card moves to "Resolved" section
5. Refresh — the alias persists; the character is gone from the queue; bubbles in the issue have the canonical speaker name
6. Click "undo" in Resolved section → alias removed, bubbles reverted, card back in queue
7. Run `pnpm review-new-characters -- --book tmnt-mmpr-iii --issue 1 --db` → with all queue items aliased or kept-as-new it exits 0; otherwise exits 2 with the URL printed
8. `pnpm typecheck` and `pnpm lint` pass clean

---

## Done definition

- [ ] `getNewCharacterReviews` query implemented in `src/server/admin/new-characters.ts`
- [ ] Page + client component mounted at the route
- [ ] `aliasNewCharacter` / `undoAliasNewCharacter` server actions wired
- [ ] `scripts/review-new-characters.ts` accepts `--db` flag with pause-and-exit-2 behavior
- [ ] `scripts/ingest.ts` integrated (defaults to `--db` mode under STORAGE_MODE=supabase)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] Manual run of acceptance test #4–#7 captured in the PR description as a screenshot/log
- [ ] Branch: `feat/review-new-characters-web` off `feat/episode-gen-phase2` HEAD
- [ ] Commit style: Commitizen format, e.g. `feat(admin): browser flow for review-new-characters`
