# Phase C: Frontend Data Fetching from Supabase

Update Next.js server components and data utilities to read from Supabase instead of `public/` JSON files and `src/data/manifest.ts`.

**Prerequisites**: Phase A (Storage) and Phase B (Database) complete and populated.

---

## What Changes

| Today | After Phase C |
|-------|--------------|
| `import manifest from '~/src/data/manifest'` (TS constant) | API route reads from `issues` table |
| `fs.readFile('public/comics/…/bubbles.json')` | Supabase query on `bubbles` table |
| `fs.readFile('public/comics/…/audio-timestamps.json')` | Supabase query on `audio_timestamps` table |
| `fs.readFile('public/comics/…/castlist.json')` | Supabase query on `castlist` table |
| Image URLs: `/comics/{book}/{issue}/pages/page-01.webp` | Supabase Storage CDN URL |
| Audio URLs: `/comics/{book}/{issue}/audio/page-01_b01.mp3` | Supabase Storage CDN URL |

---

## Supabase Client Setup

Add `@supabase/supabase-js` as a dependency (or `@supabase/ssr` for Next.js cookie-aware client if auth is added later).

```typescript
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

// Server-side client (uses service role for scripts, anon for server components)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

For scripts that write data (pipeline, apply-fixes), use `SUPABASE_SERVICE_ROLE_KEY` in a separate `scripts/lib/supabase.ts` client.

---

## Manifest: From TS Constant to API Route

### Current flow
`generate-manifest.ts` writes `src/data/manifest.ts` (a compiled TS file that's imported at build time).

### New flow
Replace the import with a server-side fetch from an API route that queries the `issues` table.

```typescript
// src/app/api/manifest/route.ts
import { supabase } from '~/lib/supabase';

export async function GET() {
  const { data: books } = await supabase
    .from('books')
    .select(`
      id, name,
      issues (id, number, name, page_count, bubble_count, audio_count,
              has_webp, has_audio, has_timestamps)
    `)
    .order('number', { foreignTable: 'issues' });

  return Response.json({ books, generatedAt: new Date().toISOString() });
}
```

Cache this route aggressively — it rarely changes:
```typescript
export const revalidate = 3600; // ISR: re-fetch at most once per hour
```

In the home page server component, replace `import manifest` with:
```typescript
const manifest = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/manifest`).then(r => r.json());
```

`src/data/manifest.ts` becomes obsolete. `generate-manifest.ts` no longer writes the TS file — it only updates the DB (handled in Phase D). Delete the file after Phase D ships.

---

## `getIssueData()` — Bubbles and Castlist

**File**: `src/server/pages/queries.ts`

```typescript
// Current:
const bubblesRaw = await fs.readFile(path.join(process.cwd(), 'public/comics', bookId, issueId, 'bubbles.json'), 'utf-8');
const castlistRaw = await fs.readFile(...);

// New:
export async function getIssueData(bookId: string, issueId: string) {
  const [{ data: bubbleRows }, { data: castRows }] = await Promise.all([
    supabase
      .from('bubbles')
      .select('id, page_number, sort_order, ocr_text, text_with_cues, type, speaker, emotion, character_type, side, voice_description, ai_reasoning, ignored, needs_audio, needs_ocr, box_2d, style')
      .eq('book_id', bookId)
      .eq('issue_id', issueId)
      .order('page_number')
      .order('sort_order'),
    supabase
      .from('castlist')
      .select('character, voice_id')
      .eq('book_id', bookId)
      .eq('issue_id', issueId),
  ]);

  // Reconstruct the Record<pageKey, Bubble[]> shape the rest of the app expects
  const allBubbles: Record<string, Bubble[]> = {};
  for (const row of bubbleRows ?? []) {
    const key = `page-${String(row.page_number).padStart(2, '0')}.jpg`;
    if (!allBubbles[key]) allBubbles[key] = [];
    allBubbles[key].push(rowToBubble(row));
  }

  const characters = [...new Set(castRows?.map(r => r.character) ?? [])].sort();

  return { allBubbles, characters };
}
```

**Shape compatibility**: The component tree still receives `Record<pageKey, Bubble[]>` — same as today. No changes needed downstream in `ReviewLayout`, `ZenComicReader`, etc.

---

## `getPageData()` — Bubbles + Timestamps for a Single Page

```typescript
export async function getPageData(bookId: string, issueId: string, pageNumber: number) {
  const [{ data: bubbleRows }, { data: tsRows }] = await Promise.all([
    supabase
      .from('bubbles')
      .select('*')
      .eq('book_id', bookId)
      .eq('issue_id', issueId)
      .eq('page_number', pageNumber)
      .order('sort_order'),
    supabase
      .from('audio_timestamps')
      .select('bubble_id, alignment, normalized_alignment')
      .eq('book_id', bookId)
      .eq('issue_id', issueId)
      .in('bubble_id', bubbleIds),  // bubbleIds from first query
  ]);

  const timestamps: Record<string, AudioTimestamps> = {};
  for (const ts of tsRows ?? []) {
    timestamps[ts.bubble_id] = { alignment: ts.alignment, normalized_alignment: ts.normalized_alignment };
  }

  return { bubbles: bubbleRows?.map(rowToBubble) ?? [], timestamps };
}
```

---

## Image and Audio URLs

All places in the frontend that construct page image or audio URLs must go through the utility from Phase A:

```typescript
import { pageImageUrl, audioUrl } from '~/lib/storage';
```

**Search for and replace**:
- `/comics/${bookId}/${issueId}/pages/page-${padded}.webp` → `pageImageUrl(bookId, issueId, n)`
- `/comics/${bookId}/${issueId}/audio/${bubbleId}.mp3` → `audioUrl(bookId, issueId, bubbleId)`

These likely appear in `ZenComicReader.tsx` and the reader page component. Check `src/` for the string `/comics/`.

**Note**: The `audioUrl()` helper in Phase A is defined as `audioUrl(bookId, issueId, bubbleId)`, but once bubbles are loaded from the DB, callers should pass `bubble.audio_storage_path` as the filename argument instead of the bubble's positional ID — existing audio files kept their original names (e.g., `page-07_b08.mp3`), and newly generated audio is named by UUID. Update the helper signature or callers accordingly: `audioUrl(bookId, issueId, bubble.audio_storage_path)`.

---

## Caching Strategy (Vercel Cost Control)

**Goal**: minimize Vercel function invocations and avoid paying for large data transfers through Vercel's network.

| Data | Strategy | Rationale |
|------|----------|-----------|
| Manifest | ISR `revalidate=3600` | Changes only when a new issue is added |
| Issue bubbles (server component) | ISR `revalidate=86400` | Changes only after apply-fixes + redeploy |
| Page data (server component) | ISR `revalidate=86400` | Same as above |
| Images (WebP) | Served directly from Supabase CDN | Never goes through Vercel |
| Audio (MP3) | Served directly from Supabase CDN | Never goes through Vercel |

For ISR, the route segment config at the top of each page file:
```typescript
export const revalidate = 86400; // 24 hours
```

**Important**: With ISR, content won't update instantly after `apply-fixes` runs. Phase E addresses this by triggering a revalidation via Vercel's `revalidatePath` API after fixes are applied.

---

## `src/data/manifest.ts` Deprecation

After Phase C ships:
1. `generate-manifest.ts` no longer writes the TS file (Phase D handles this)
2. Remove `src/data/manifest.ts` from the repo
3. Remove the static import from any component that used it
4. All manifest reads go through the API route

---

## Testing Plan

1. Run the dev server against production Supabase (not local emulator — use the real DB).
2. Navigate to a book → issue → reader. Confirm pages load, audio plays, karaoke sync works.
3. Navigate to review page. Confirm bubbles display, characters load in sidebar datalist.
4. Check Network tab: image and audio requests should resolve to `supabase.co` CDN, not `/comics/`.
5. Check Vercel function logs: no `/comics/` file reads in production.

---

## Checklist

- [ ] Install `@supabase/supabase-js`
- [ ] Write `src/lib/supabase.ts` (anon client)
- [ ] Write `src/lib/storage.ts` (URL builders)
- [ ] Write `/api/manifest` route with ISR
- [ ] Update `getIssueData()` in `src/server/pages/queries.ts`
- [ ] Update `getPageData()` in `src/server/pages/queries.ts`
- [ ] Replace all hardcoded image/audio URL patterns in `src/`
- [ ] Add `revalidate` to reader and review page route segments
- [ ] Remove `fs` imports from `src/server/pages/queries.ts`
- [ ] Smoke test in dev against real Supabase
- [ ] Deploy to Vercel and verify no `public/comics/` reads
- [ ] (After verification) Delete `public/comics/` issue directories
