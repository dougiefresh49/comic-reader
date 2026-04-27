# Phase E: Review Flow with Alias Scoping

Two goals for this phase:
1. **Alias scoping**: Aliases in the DB can now be scoped to a book or series — add tooling to create and manage scoped aliases.
2. **Review flow DB writes**: After Phase D, `apply-fixes` already writes to the DB from the terminal. This phase makes the apply step possible from the browser (no local terminal required).

**Prerequisites**: Phase D complete.

---

## Part 1: Scoped Alias Management

### Background

The `aliases` table (from Phase B) has a `scope` column (`global`, `series`, `book`) and a `scope_id`. The old `alias-map.json` was flat and global. Now aliases can be book-specific — e.g., "Billy" maps to "Blue Ranger" only within the TMNT x MMPR book, without polluting the global namespace.

### When to use each scope

| Scope | Use for |
|-------|---------|
| `global` | Universally canonical aliases (franchise-wide nicknames, typos) |
| `series` | Aliases specific to a multi-book arc (future use, once series model exists) |
| `book` | Aliases specific to one book — e.g., "Tommy" should be "Tommy Oliver" in TMNT x MMPR but not in a solo MMPR book |

### CLI for alias management

Add `scripts/manage-aliases.ts`:

```bash
# List all aliases for a book
pnpm manage-aliases -- --list --book tmnt-mmpr-iii

# Add a book-scoped alias
pnpm manage-aliases -- --add --alias "tommy" --canonical "Tommy Oliver" --scope book --book tmnt-mmpr-iii

# Add a global alias
pnpm manage-aliases -- --add --alias "splinter" --canonical "Master Splinter" --scope global

# Remove an alias
pnpm manage-aliases -- --remove --alias "tommy" --scope book --book tmnt-mmpr-iii
```

This replaces manual edits to `data/alias-map.json`. The file can be kept as a local snapshot for bootstrapping a new environment, but the DB is authoritative after Phase D.

---

## Part 2: Browser-Based Apply-Fixes (Hosted Review Flow)

### Current state (post Phase D)

The review cycle is:
1. Open `/book/{bookId}/{issueId}/review` in browser
2. Make edits (stored in IndexedDB)
3. Click "Export Fixes" → download `fixes.json`
4. Run `pnpm apply-fixes --fixes=./fixes.json` in terminal
5. Wait for audio regeneration, manifest update, redeploy (or ISR refresh)

Step 4 requires a local dev environment. This phase eliminates that requirement.

### New flow

1. Open `/book/{bookId}/{issueId}/review` in browser
2. Make edits (stored in IndexedDB)
3. Click "Apply Fixes" → POST to `/api/apply-fixes`
4. Server applies fixes directly to the DB and invalidates ISR cache
5. Browser reflects updated state on next page load

Steps 4–5 happen on the server, no terminal needed.

### `bubbleId` Resolution: Legacy IDs vs UUIDs

`fixes.json` `bubbleId` values are the positional IDs the Review UI uses as `selectedId`. During the migration period (before Phase C ships), the Review UI loads bubbles from local `bubbles.json` and uses `page-{NN}_b{NN}` positional IDs. After Phase C, it loads from the DB and uses UUIDs.

The `/api/apply-fixes` route must handle both:

```typescript
async function resolveBubbleUuid(
  client: SupabaseClient,
  bookId: string,
  issueId: string,
  bubbleId: string
): Promise<string> {
  // If it looks like a UUID, use it directly
  if (/^[0-9a-f-]{36}$/.test(bubbleId)) return bubbleId;

  // Otherwise look up by legacy_id
  const { data } = await client
    .from('bubbles')
    .select('id')
    .eq('book_id', bookId).eq('issue_id', issueId).eq('legacy_id', bubbleId)
    .single();
  if (!data) throw new Error(`No bubble found for legacy ID ${bubbleId}`);
  return data.id;
}
```

Call `resolveBubbleUuid` before each DB operation. After Phase C ships and all `fixes.json` exports use UUIDs, this function short-circuits on the UUID check and the legacy path becomes dead code — remove it then.

### API Route: `/api/apply-fixes`

```typescript
// src/app/api/apply-fixes/route.ts
// POST body: fixes.json payload

export async function POST(req: Request) {
  // Auth check: require APPLY_FIXES_SECRET header (simple shared secret for family use)
  const secret = req.headers.get('x-apply-fixes-secret');
  if (secret !== process.env.APPLY_FIXES_SECRET) return new Response('Unauthorized', { status: 401 });

  const fixes: FixesJson = await req.json();
  const { bookId, issueId, fixes: fixList } = fixes;

  const serviceClient = createServiceClient(); // uses SUPABASE_SERVICE_ROLE_KEY

  for (const fix of fixList) {
    if (fix.action === 'update') {
      const uuid = await resolveBubbleUuid(serviceClient, bookId, issueId, fix.bubbleId);
      await serviceClient.from('bubbles')
        .update({ ...mapChangesToColumns(fix.changes), updated_at: new Date() })
        .eq('id', uuid);
    } else if (fix.action === 'delete') {
      const uuid = await resolveBubbleUuid(serviceClient, bookId, issueId, fix.bubbleId);
      await serviceClient.from('bubbles').delete().eq('id', uuid);
    } else if (fix.action === 'add') {
      await serviceClient.from('bubbles').insert(fixToRow(fix, bookId, issueId));
    } else if (fix.action === 'reorder') {
      // orderedIds are either UUIDs (Phase C+) or legacy IDs (pre-Phase C)
      for (const [idx, bubbleId] of fix.orderedIds.entries()) {
        const uuid = await resolveBubbleUuid(serviceClient, bookId, issueId, bubbleId);
        await serviceClient.from('bubbles').update({ sort_order: idx }).eq('id', uuid);
      }
    }
  }

  // Invalidate ISR cache
  revalidatePath(`/book/${bookId}/${issueId}`);
  revalidatePath(`/book/${bookId}/${issueId}/review`);

  // Mark bubbles that changed text/speaker as needs_audio
  const audioFixes = fixList.filter(f => f.action === 'update' && needsAudioChange(f.changes));
  if (audioFixes.length > 0) {
    const uuids = await Promise.all(
      audioFixes.map(f => resolveBubbleUuid(serviceClient, bookId, issueId, f.bubbleId))
    );
    await serviceClient.from('bubbles')
      .update({ needs_audio: true })
      .in('id', uuids);
  }

  return Response.json({ applied: fixList.length });
}
```

**Limitation**: The API route handles the data changes but cannot run `generate-audio` — audio regeneration still requires the local pipeline. The `needs_audio` flag is set in the DB so the next local pipeline run (or manual `pnpm generate-audio`) picks up the changes.

### UI Changes in Review Interface

Replace "Export Fixes" button with two options:
- **"Apply to DB"** — POSTs to `/api/apply-fixes`, clears IndexedDB after success
- **"Download fixes.json"** — existing export, kept for offline/pipeline use

Add `NEXT_PUBLIC_APPLY_FIXES_SECRET` to the browser environment. This is a shared secret for family use — not a production auth system.

**After "Apply to DB" succeeds**:
- Show a success toast: "X fixes applied. Audio regeneration needed for Y bubbles."
- Clear the local IndexedDB edit state
- Optionally reload the page to show the refreshed data

---

## Part 3: Sync Runbook — Browser Fix → Audio Regeneration → Publish

After browser-based fixes are applied via "Apply to DB", the local `assets/comics/{book}/{issue}/bubbles.json` is out of sync with the DB. Fixes that require audio regeneration (speaker name changes, text edits) set `needs_audio = true` in the DB. To complete those fixes:

```bash
# Step 1 — Pull current DB state to local assets
pnpm sync-from-db -- --book tmnt-mmpr-iii --issue 1
# Reconstructs bubbles.json from the bubbles table (preserving legacy_id as the bubble .id field)
# Reconstructs audio-timestamps.json from audio_timestamps rows

# Step 2 — Regenerate audio for flagged bubbles
pnpm generate-audio -- --book tmnt-mmpr-iii --issue 1 --only-flagged
# Reads needs_audio = true from local bubbles.json
# Produces {uuid}.mp3 for newly-added bubbles, {legacy_id}.mp3 for pre-migration bubbles
# Updates audio_storage_path in local bubbles.json for newly generated files

# Step 3 — Publish updated audio + DB state back to Supabase
pnpm ingest -- --book tmnt-mmpr-iii --issue 1 --from-step copy-to-public
# Uploads new/updated MP3s to comic-audio bucket using audio_storage_path
# Upserts bubbles (clears needs_audio), audio_timestamps, issue counts
```

**For non-audio fixes** (sort order, text corrections already in DB, speaker name fixes without regeneration): nothing local to do — the "Apply to DB" click already made them live. ISR cache is invalidated automatically.

`scripts/sync-from-db.ts` implementation sketch:

```typescript
// Fetch all bubbles for the issue from DB, ordered by page_number, sort_order
const { data: rows } = await supabase
  .from('bubbles')
  .select('*, audio_timestamps(*)')
  .eq('book_id', bookId).eq('issue_id', issueId)
  .order('page_number').order('sort_order');

// Reconstruct bubbles.json structure (keyed by page filename, legacy_id as .id)
const bubblesJson = groupBy(rows, r => `page-${String(r.page_number).padStart(2,'0')}.jpg`);
// Write to assets/comics/{book}/{issue}/data/bubbles.json

// Reconstruct audio-timestamps.json (keyed by legacy_id for pipeline compatibility)
const timestamps = Object.fromEntries(
  rows.filter(r => r.audio_timestamps?.length).map(r => [r.legacy_id, r.audio_timestamps[0]])
);
// Write to assets/comics/{book}/{issue}/data/audio-timestamps.json
```

---

## What Still Requires Local Pipeline

These steps are not feasible in a hosted environment in Phase E:

| Task | Why local |
|------|-----------|
| Audio regeneration (`generate-audio`) | ElevenLabs API, large file output, needs local `audio/` dir |
| OCR re-runs (`ocr-flagged-bubbles`) | Gemini Vision calls, writes to `bubbles.json` |
| `copy-to-public` (now `publish-to-supabase`) | Needs local audio/webp files to upload |
| Interactive review steps (review-speakers, review-new-characters) | Terminal-based prompts |

See [future-scope.md](future-scope.md) for what a server-based pipeline could look like.

---

## Checklist

- [ ] Write `scripts/manage-aliases.ts` CLI
- [ ] Add `manage-aliases` to `package.json` scripts
- [ ] Write `/api/apply-fixes` route (with service role client)
- [ ] Add `APPLY_FIXES_SECRET` and `NEXT_PUBLIC_APPLY_FIXES_SECRET` to env
- [ ] Add `SUPABASE_SERVICE_ROLE_KEY` to Vercel env (server-only, not `NEXT_PUBLIC_`)
- [ ] Update Review UI: replace "Export" with "Apply to DB" + "Download" buttons
- [ ] Write `scripts/sync-from-db.ts` pull script
- [ ] Add `sync-from-db` to `package.json` scripts
- [ ] Test full cycle: browser edit → Apply to DB → sync-from-db → generate-audio → publish-to-supabase
