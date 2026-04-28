# Data Hosting Migration

Move assets and data off the local filesystem and Vercel `public/` folder into a hosted database and object storage. The current `public/` approach won't scale on Vercel (large deploys, no CDN for audio, no runtime writes).

---

## Why This Is Needed

| Problem | Today | After Migration |
|---------|-------|----------------|
| Images/audio in `public/` | Bundled into Vercel deploy (~50 MB+ per issue) | Served from CDN via Supabase Storage URLs |
| Manifest is a compiled `.ts` file | Requires redeploy to add/update an issue | API route reads live from DB |
| `bubbles.json` served as a static file | No partial fetch, full 424 KB download per issue | Per-page queries from Postgres |
| `alias-map.json` is global, flat | Can't scope aliases to a series or book | DB rows with scope column |
| Review fixes applied locally only | Requires local terminal access | Writes go directly to DB (Phase E) |
| Ingest pipeline is 100% local | Must run from laptop | Non-interactive steps can move to a server (future scope) |

---

## Recommended Stack

**Database**: [Supabase](https://supabase.com) — hosted PostgreSQL, free tier is generous (500 MB DB, 1 GB Storage). First paid tier is $25/month (8 GB DB, 100 GB Storage).

**File Storage**: Supabase Storage — S3-compatible object storage with a built-in CDN. Same service, same dashboard, same API key. Could migrate files to Cloudflare R2 later if costs grow, but Supabase is fine to start.

**Estimated storage per issue**:
- WebP pages: ~2 MB
- MP3 audio: ~20–25 MB
- **Total per issue: ~27 MB**

Free tier (1 GB) covers ~37 issues before needing paid. At $0.021/GB/month on the free plan overage (or included in $25 paid tier), cost is negligible for a personal project.

---

## Phase Index

| Phase | Spec | Scope | Status |
|-------|------|-------|--------|
| A | [phase-a-storage.md](phase-a-storage.md) | Supabase Storage for WebP images + MP3 audio | pending |
| B | [phase-b-database.md](phase-b-database.md) | DB schema + migrate JSON data (bubbles, timestamps, manifest, registry) | pending |
| C | [phase-c-frontend.md](phase-c-frontend.md) | Frontend/server data fetching from Supabase instead of `public/` | pending |
| D | [phase-d-pipeline.md](phase-d-pipeline.md) | Ingest pipeline uploads to Supabase instead of `copy-to-public` | pending |
| E | [phase-e-review.md](phase-e-review.md) | Review flow: apply-fixes writes to DB; alias-map in DB with scoping | pending |

**Suggested implementation order**: A → B → C → D → E. Phases A and B can be done in parallel. Phase C depends on B. Phase D depends on A+B. Phase E depends on D.

---

## Data Inventory

### Files That Become DB Rows

| File | Table(s) | Notes |
|------|----------|-------|
| `public/comics/manifest.json` + `src/data/manifest.ts` | `series`, `books`, `issues` | Computed via API; no more compiled TS |
| `public/comics/{book}/{issue}/bubbles.json` | `bubbles` | One row per bubble; page is a column |
| `public/comics/{book}/{issue}/audio-timestamps.json` | `audio_timestamps` | JSONB column (alignment arrays too complex to normalize) |
| `public/comics/{book}/{issue}/pages.json` | `pages` | One row per page (width, height, storage path) |
| `public/comics/{book}/{issue}/castlist.json` | `castlist` | One row per character+voice pair, scoped to issue |
| `data/alias-map.json` | `aliases` | One row per alias with scope (global / series / book) |
| `data/character-registry.json` | `characters`, `character_appearances` | Normalized from nested JSON |

### Files That Become Storage Objects

| File Pattern | Bucket | Notes |
|-------------|--------|-------|
| `public/comics/{book}/{issue}/pages/*.webp` | `comic-pages` | Public bucket; served directly by CDN |
| `public/comics/{book}/{issue}/audio/*.mp3` | `comic-audio` | Public bucket; served directly by CDN |

### Files That Stay Local (Assets / Intermediate)

| Path | Reason |
|------|--------|
| `assets/comics/{book}/{issue}/pages/` | Source JPEGs; input only, not served |
| `assets/comics/{book}/{issue}/pages-webp/` | Intermediate; uploaded to Storage then discardable |
| `assets/comics/{book}/{issue}/data/gemini-context/` | AI cache; local only |
| `assets/comics/{book}/{issue}/data/predictions/` | Intermediate OCR; local only |
| `assets/comics/{book}/{issue}/checkpoint.json` | Pipeline state; local only |
| `data/character-voice-descriptions.json` | Input to generate-voice-models; can be local |
| `data/source-material.json` | Input to generate-voice-models; can be local |

---

## Features Unlocked After Phase E

These features are specced separately in `specs/features/` and depend on the Phase A–E migration being complete:

| Feature | Spec | What it needs from this migration |
|---------|------|-----------------------------------|
| Review speakers browser UI | [review-speakers-browser.md](../review-speakers-browser.md) | `speaker_reviews` table (Phase B patch) |
| Source page upload + admin dashboard | [upload-and-pipeline-trigger.md](../upload-and-pipeline-trigger.md) | `comic-pages-raw` bucket (Phase A patch) + 5 columns on `issues` (Phase B patch) |
| Casting browser UI | [casting-browser.md](../casting-browser.md) | `comic-voice-clips` bucket (Phase A patch) + `casting_tasks` table + columns on `character_appearances` (Phase B patch) |

Each spec documents its own Phase B DDL additions. Apply all three sets of additions to `phase-b-database.md` before running the initial migration.

---

## Future Scope

See [future-scope.md](future-scope.md) for notes on:
- Running ingest pipeline steps in a cloud environment (DigitalOcean droplet, etc.)
- Hosted review flow where `apply-fixes` writes to DB from the browser (no local terminal needed)
