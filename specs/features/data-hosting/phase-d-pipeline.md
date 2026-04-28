# Phase D: Pipeline Updates for Supabase

Update the ingest pipeline so that the final output steps write to Supabase Storage and the database instead of `public/comics/`. The intermediate steps (OCR, Gemini context, sorting, voice generation) stay local — they still write to `assets/` as today.

**Prerequisites**: Phase A, B, and C complete.

---

## What Changes in the Pipeline

The pipeline's local file structure is **unchanged for steps 1–12**. All intermediate data continues to live in `assets/comics/{book}/issue-{n}/`. The changes are only in the final two steps:

| Step | Current behavior | New behavior |
|------|-----------------|-------------|
| 12 `copy-to-public` | Copies WebP + audio + JSON to `public/comics/` | Uploads WebP/MP3 to Storage; upserts JSON data to DB |
| 13 `generate-manifest` | Writes `public/comics/manifest.json` + `src/data/manifest.ts` | Updates `issues` table counts + flags; no TS file write |

All other steps (1–11) are unchanged.

---

## Step 4: `get-context` — Write to `page_context` Table

After Phase D, `get-context` should upsert the full Gemini analysis output into the `page_context` table immediately after each page is processed:

```typescript
await supabase.from('page_context').upsert({
  book_id:      bookId,
  issue_id:     issueId,
  page_number:  pageNum,
  gemini_model: GEMINI_HIGH,
  raw_response: geminiOutput,
  updated_at:   new Date(),
}, { onConflict: 'book_id,issue_id,page_number' });
```

This makes the Gemini context available to cloud pipeline steps downstream and allows re-running steps 5–8 without needing the local `gemini-context/` cache. On re-runs, check `page_context` first — if a row exists with the same model, skip the Gemini call.

---

## Step 12: `copy-to-public` → `publish-to-supabase`

Rename the step from `copy-to-public` to `publish-to-supabase` (or keep the name but change the implementation — keeping the name is less disruptive to the pipeline checkpoint system).

**New implementation of `copy-to-public.ts`**:

```
1. Upload pages-webp/*.webp → Storage bucket "comic-pages"/{bookId}/{issueId}/
2. Upload audio/*.mp3      → Storage bucket "comic-audio"/{bookId}/{issueId}/
3. Upsert pages rows       from pages.json
4. Upsert bubbles rows     from bubbles.json (full replace for this issue)
5. Upsert audio_timestamps from audio-timestamps.json
6. Upsert castlist rows    from castlist.json
7. Update issues row       (page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps)
```

**Upsert strategy for bubbles**: Do not delete-and-reinsert on pipeline re-runs — this would mint new UUIDs and break `audio_timestamps` FKs. Instead, upsert on `(book_id, issue_id, legacy_id)`:

```typescript
// In copy-to-public.ts
for (const row of flattenBubbles(bubblesJson, bookId, issueId)) {
  // Resolve existing UUID if the bubble was already migrated
  const { data: existing } = await supabase
    .from('bubbles')
    .select('id')
    .eq('book_id', bookId).eq('issue_id', issueId).eq('legacy_id', row.legacy_id)
    .maybeSingle();

  if (existing) {
    // Update in place — UUID stays the same
    await supabase.from('bubbles').update({ ...row, updated_at: new Date() }).eq('id', existing.id);
  } else {
    // New bubble — let Supabase assign UUID; set audio_storage_path to legacy filename
    await supabase.from('bubbles').insert({ ...row, audio_storage_path: `${row.legacy_id}.mp3` });
  }
}
```

**`audio_storage_path` on publish**: When a bubble's audio has been regenerated post-migration (UUID-named file), the pipeline sets `audio_storage_path = '{uuid}.mp3'` on the bubble row. The upload step reads this column to find the correct local MP3 filename and uploads it under the same path in `comic-audio`.

```typescript
// Uploading audio for a bubble
const mp3Filename = bubble.audio_storage_path ?? `${bubble.legacy_id}.mp3`;
const localPath = path.join(audioDir, mp3Filename);
const storagePath = `${bookId}/${issueId}/${mp3Filename}`;
await supabase.storage.from('comic-audio').upload(storagePath, fs.readFileSync(localPath), { upsert: true });
```

**Upload parallelism**: Use `p-limit` or manual batching with `Promise.allSettled` — 10 concurrent uploads max to avoid Supabase rate limits. Log progress (e.g., "Uploading pages 12/26").

---

## Step 13: `generate-manifest`

Remove the `src/data/manifest.ts` write. Instead, update the `issues` table counts and flags. The manifest API route in Phase C handles discovery at runtime.

```typescript
// generate-manifest.ts (simplified)
// No longer scans public/; reads from the DB to compute counts
// Updates issues.page_count, bubble_count, audio_count, has_webp, has_audio, has_timestamps
// Writes nothing to public/ or src/data/
```

The `public/comics/manifest.json` write can also be removed. Keep the checkpoint step so the pipeline marks this complete.

---

## `apply-fixes.ts` Changes

After Phase D, `apply-fixes.ts` needs to write to the DB, not just local `assets/`. The flow:

1. Read `fixes.json` (unchanged)
2. Read current `assets/comics/{bookId}/{issueId}/bubbles.json` (unchanged — still the source of truth for the pipeline)
3. Apply fixes to the local JSON (unchanged)
4. Write updated `bubbles.json` to `assets/` (unchanged)
5. **NEW**: Upsert changed bubbles to the `bubbles` table in Supabase
6. **NEW**: Call Vercel's `revalidatePath` to invalidate ISR cache for the affected issue

Step 5 can be a targeted upsert — only the bubbles that changed, not a full replace:

```typescript
const changedBubbles = fixes.fixes.map(f => f.bubbleId).filter(id => id !== '__page-reorder__');
// For 'reorder' fixes: update sort_order column for affected page
// For 'delete' fixes: delete row from bubbles
// For 'add' fixes: insert new row
// For 'update' fixes: upsert row
```

Step 6 — ISR revalidation:
```typescript
// After all DB writes complete:
await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/revalidate`, {
  method: 'POST',
  body: JSON.stringify({ bookId, issueId }),
  headers: { 'x-revalidate-secret': process.env.REVALIDATE_SECRET }
});
```

```typescript
// src/app/api/revalidate/route.ts
import { revalidatePath } from 'next/cache';

export async function POST(req: Request) {
  const secret = req.headers.get('x-revalidate-secret');
  if (secret !== process.env.REVALIDATE_SECRET) return new Response('Unauthorized', { status: 401 });
  const { bookId, issueId } = await req.json();
  revalidatePath(`/book/${bookId}/${issueId}`);
  revalidatePath(`/book/${bookId}/${issueId}/review`);
  return Response.json({ revalidated: true });
}
```

Add `REVALIDATE_SECRET` to `.env`.

---

## `alias-map.ts` Utility Update

`scripts/alias-map.ts` currently reads from `data/alias-map.json`. After Phase D, it should query the `aliases` table:

```typescript
// scripts/utils/alias-map.ts
export async function getCanonicalName(
  name: string,
  context?: { bookId?: string; seriesId?: string }
): Promise<string> {
  const lower = name.toLowerCase().trim();
  
  // Query priority: book → series → global
  const conditions = [
    { scope: 'global', scope_id: null }
  ];
  if (context?.seriesId) conditions.unshift({ scope: 'series', scope_id: context.seriesId });
  if (context?.bookId) conditions.unshift({ scope: 'book', scope_id: context.bookId });

  for (const condition of conditions) {
    const { data } = await supabase
      .from('aliases')
      .select('canonical')
      .eq('alias', lower)
      .eq('scope', condition.scope)
      .is('scope_id', condition.scope_id)  // null check for global
      .maybeSingle();
    if (data) return data.canonical;
  }
  
  return name; // no alias found, return as-is
}
```

**Performance note**: `getCanonicalName` is called per-bubble in `generate-audio`. Load the alias table into memory at script startup (one query, cache in a Map) rather than one query per bubble.

---

## Local Fallback During Migration

While transitioning, keep both `public/` and Supabase writes working. The `STORAGE_MODE` env var in `copy-to-public.ts` (mentioned in CLAUDE.md as already having an `s3` flag stub) can be extended:

```
STORAGE_MODE=local    # current default (copy to public/)
STORAGE_MODE=supabase # new mode (upload to Supabase)
STORAGE_MODE=both     # transition period: write both
```

Run `both` mode during the transition to verify Supabase data matches `public/` before switching Phase C to read from Supabase.

---

## Checklist

- [ ] Extend `copy-to-public.ts` with Supabase upload logic (`STORAGE_MODE=supabase`)
- [ ] Use legacy_id upsert strategy (not delete-and-reinsert) to preserve UUIDs across pipeline re-runs
- [ ] Read `audio_storage_path` from bubble row when determining MP3 filename to upload
- [ ] Write `scripts/lib/supabase.ts` (service role client for scripts)
- [ ] Update `get-context` to upsert into `page_context` table after each page
- [ ] Update `generate-manifest.ts` to update DB instead of writing files
- [ ] Update `apply-fixes.ts` to upsert changed bubbles to DB after local write (targeted, not full replace)
- [ ] Add `/api/revalidate` route and `REVALIDATE_SECRET` env var
- [ ] Update `scripts/utils/alias-map.ts` to query DB (with startup cache)
- [ ] Test pipeline end-to-end with `STORAGE_MODE=both` on a new issue
- [ ] Verify DB rows and Storage files match local `public/` output
- [ ] Verify `audio_storage_path` on each bubble row matches the actual MP3 in `comic-audio` bucket
- [ ] Switch `STORAGE_MODE=supabase` as default
- [ ] Remove `STORAGE_MODE=local` path after one successful production run
