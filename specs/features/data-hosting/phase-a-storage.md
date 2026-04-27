# Phase A: Supabase Storage for Static Assets

Move WebP images and MP3 audio files from `public/comics/` into Supabase Storage buckets so they are served via CDN instead of being bundled in the Vercel deployment.

**Prerequisite**: Supabase project created, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

---

## Buckets

Create five buckets in Supabase Storage:

| Bucket | Access | Path convention | Purpose |
|--------|--------|----------------|---------|
| `comic-pages` | Public (no auth) | `{bookId}/{issueId}/page-01.webp` | Served pages (CDN) |
| `comic-audio` | Public (no auth) | `{bookId}/{issueId}/{bubbleId}.mp3` | Served audio (CDN) |
| `comic-ocr-crops` | Private (service role only) | `{bookId}/{issueId}/page-{NN}/{legacyId}.webp` | Pipeline intermediates — bubble crops + Roboflow predictions |
| `comic-pages-raw` | Private (service role + signed upload) | `{bookId}/{issueId}/source/page-01.jpg` | Source JPEGs uploaded after scrape-pages; input to pipeline steps 2–3 |
| `comic-voice-clips` | Private (service role only) | `{characterId}/{appearanceId}.mp3` | Audio clips used to create ElevenLabs PVC voice models |

`comic-pages` and `comic-audio` are public — URLs work directly in `<img>` and `<audio>` tags without signed URLs.

`comic-ocr-crops` is private — these are pipeline intermediates (bubble crop images and Roboflow prediction JSONs), not CDN content. Access requires the service role key. The Review UI fetches crops via a server component or API route that holds the service role key, not from the browser directly.

`comic-pages-raw` is private but supports **signed upload URLs** — the `/admin/new-issue` browser upload page gets a short-lived signed URL from an API route and PUTs files directly to Storage from the browser. This avoids routing large files through Vercel functions (4.5 MB body limit).

`comic-voice-clips` is private service-role-only — clips are downloaded server-side (via yt-dlp or browser upload) and written by the casting API route. Never accessed from the browser directly.

### comic-ocr-crops path conventions

| Content | Path |
|---------|------|
| Bubble crop image | `{bookId}/{issueId}/page-{NN}/{legacyId}.webp` |
| Roboflow predictions | `{bookId}/{issueId}/predictions/page-{NN}.json` |

Crops are stored as WebP (converted from JPEG at upload time with `sharp`, max 800px dimension) to reduce size 50–70% with no meaningful quality loss for Gemini Vision.

**Why store crops**: Once crops are in Storage with `crop_storage_path` on the bubble row, the Review UI can display the exact image Gemini read when producing OCR text. A future `/api/ocr-bubble` route can fetch the crop, re-run Gemini, and write the result to the DB — no local pipeline needed for single-bubble OCR fixes.

---

## URL Shape

Supabase Storage public URLs follow this pattern:
```
https://<project-ref>.supabase.co/storage/v1/object/public/<bucket>/<path>
```

Example:
```
https://xxxx.supabase.co/storage/v1/object/public/comic-pages/tmnt-mmpr-iii/issue-1/page-01.webp
https://xxxx.supabase.co/storage/v1/object/public/comic-audio/tmnt-mmpr-iii/issue-1/page-01_b01.mp3
```

Store the project base URL in `NEXT_PUBLIC_SUPABASE_URL` (already standard for Supabase apps). Construct asset URLs in a single utility:

```typescript
// src/lib/storage.ts
export function pageImageUrl(bookId: string, issueId: string, pageNum: number): string {
  const padded = String(pageNum).padStart(2, "0");
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comic-pages/${bookId}/${issueId}/page-${padded}.webp`;
}

export function audioUrl(bookId: string, issueId: string, bubbleId: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/comic-audio/${bookId}/${issueId}/${bubbleId}.mp3`;
}
```

---

## Upload Script

Add `scripts/upload-to-storage.ts` as a manual/pipeline script. It uploads from `public/comics/` (or directly from `assets/comics/`) to Supabase Storage.

```typescript
// scripts/upload-to-storage.ts
// Usage: pnpm upload-to-storage -- --book tmnt-mmpr-iii --issue 1
// Uploads pages-webp/*.webp → comic-pages bucket
//         audio/*.mp3       → comic-audio bucket
// Skips files already in storage (upsert: false by default, pass --force to overwrite)
```

**Upload strategy**:
- Use `supabase.storage.from(bucket).upload(path, buffer, { upsert: false })` to skip existing files (idempotent).
- Pass `--force` flag to use `upsert: true` for re-uploads after regeneration.
- Parallelize uploads with `Promise.allSettled` + concurrency limit (e.g., 10 at a time) to avoid rate limits.
- Log skipped (already exists), uploaded, and failed files separately.

**Integration with pipeline**:
- In Phase D, this script replaces `copy-to-public.ts` for the images/audio portion.
- For now (Phase A), run it manually after the existing pipeline completes.

---

## Environment Variables

Add to `.env` and `.env.example`:
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>          # used by scripts only
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co     # used by frontend
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>              # used by frontend
```

The service role key is only needed in scripts (bypasses RLS). The anon key is safe to expose in the browser.

---

## Vercel Deployment Impact

Once assets are in Storage, `public/comics/` can be emptied for new issues (existing issues should stay in `public/` until Phase C deploys and routes are verified). Removing ~27 MB per issue from the deploy bundle reduces cold-start time and Vercel build size.

**Do not delete `public/comics/` contents until Phase C is live and tested.** The frontend still reads from `public/` until Phase C swaps the data sources.

---

## Rollback

If Storage is unreachable, the CDN URL simply 404s. Rollback = re-run `copy-to-public` to restore files in `public/` and revert Phase C URL changes in the frontend. Keep `copy-to-public.ts` intact until Phase D ships.

---

## Checklist

- [ ] Create Supabase project
- [ ] Create `comic-pages` bucket (public)
- [ ] Create `comic-audio` bucket (public)
- [ ] Create `comic-ocr-crops` bucket (private, service role only)
- [ ] Create `comic-pages-raw` bucket (private, enable signed upload URLs)
- [ ] Create `comic-voice-clips` bucket (private, service role only)
- [ ] Add env vars to `.env` and Vercel dashboard
- [ ] Write `scripts/upload-to-storage.ts` (pages + audio + OCR crops)
- [ ] Upload existing issue(s) as smoke test
- [ ] Verify CDN URLs for `comic-pages` and `comic-audio` resolve correctly in browser
- [ ] Verify `comic-ocr-crops` is not publicly accessible (returns 403 without service role key)
- [ ] Add `upload-to-storage` to `package.json` scripts
