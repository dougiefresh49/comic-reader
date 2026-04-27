# Opinions: Best Solutions for Non-Cloud-Ready Ingest Steps

**Date:** 2026-04-27  
**Context:** Follow-up to `web-based-ingest--ideas.md`. Picks the recommended approach for each gap and explains the tradeoffs. These are opinions to review before speccing the work — not a spec itself.

---

## Gap 1: Source JPEG Upload

**Recommendation: Option B (semi-local) + a simple manual upload page**

### Why not Browserbase (hosted Stagehand)

Browserbase works and the pricing is reasonable for personal use (each scrape is likely under 5 minutes = < $0.01). But it adds a layer of hosted infrastructure and API integration for a step that you're the only person running, probably once a month. The complexity vs. benefit ratio is wrong right now.

Browserbase becomes the right call only if you want to let someone else trigger ingestion without any local setup — i.e., if the app ever becomes multi-user or you want to hand off ingestion to a family member. Note it for that future, but don't build it now.

Option D (Kindle integration) is a nice long-term idea but out of scope until the app potentially becomes a real product. Leave it as a research note.

### The recommended combo

**Option B** for the normal scrape flow:

```bash
# Current (stays local):
pnpm scrape-pages -- --url <url> --book tmnt-mmpr-iii --issue 3

# Add this after:
pnpm upload-source-pages -- --book tmnt-mmpr-iii --issue 3
# Uploads assets/comics/{book}/{issue}/pages/*.jpg → comic-pages-raw bucket
# Then triggers the cloud pipeline steps 2–11 via an API call or just confirms upload
```

`upload-source-pages` is a thin script on top of the existing Supabase upload utility. One command, done. The pipeline can be triggered from the upload confirmation or still run locally — either works.

**A manual upload page** alongside it (subset of Option A):

Add `/admin/new-issue` with a drag-and-drop file input that uploads JPEGs directly to `comic-pages-raw`. This is the fallback for pages from sources other than a scrapeable URL (downloaded from another app, pulled from a different source, etc.). It's also a prerequisite for ever making the pipeline cloud-triggered — you need a way to get pages into the bucket without the terminal.

The manual upload page is ~2 hours of work on top of Phase A infrastructure. Worth doing it at the same time as the `upload-source-pages` script since they share the same bucket and upload logic.

### What this unlocks

Once JPEGs land in `comic-pages-raw`, steps 2–11 are all API calls that can run server-side. You're not obligated to cloud-trigger them immediately — you can still run the pipeline locally and have it read from the bucket. The value is that the option exists.

---

## Gap 2: Interactive Terminal Steps

### Step 4.5 — `review-speakers` Browser UI

**Build this first. It has the highest impact and is already specced.**

The speaker review step is where bad data enters the pipeline — wrong names, missing aliases, AI hallucinations. Everything downstream (alias-map, castlist, audio generation) is only as good as what comes out of this step. Moving it to a browser UI also eliminates the terminal session requirement for the most common mid-pipeline pause.

The existing spec in `specs/features/review-speakers.md` covers the interaction model well. The URL pattern from the ideas doc makes sense: `/admin/issue/{bookId}/{issueId}/review/speakers`.

**One addition to the existing spec:** integrate inline alias creation here rather than in a separate step (see below).

---

### Step 8.5 — `interactive-alias-review`

**Recommendation: merge into the review-speakers UI, not a separate page.**

The alias review step happens because the speaker review step might have missed something, or new names slipped through clean-voice-descriptions. But in practice, the moment you're reviewing a speaker name and it doesn't match any known character, *that's* when you either create a new character or alias it to an existing one. These two decisions are the same decision made at the same time — splitting them into separate pages adds friction for no benefit.

In the review-speakers browser UI, when a user clicks "Edit" on a speaker name:
- Autocomplete from the character registry
- If they type a name that doesn't match: offer [Create new character] / [Alias to existing]
- Aliasing writes to the `aliases` table immediately; creating writes to `characters`

This makes step 8.5 a feature *within* the review-speakers page rather than its own pipeline step or page. The separate `interactive-alias-review` spec in `features.md` can be closed as "covered by review-speakers browser UI" once that's built.

---

### Step 9 — `find-voice-sources` / Casting Browser UI

**Recommendation: dedicated casting page, but only for new-to-registry characters.**

This is the most complex interactive step but also the one where the UI investment pays off the most. The terminal flow is awkward — Gemini dumps suggestions, you copy-paste a YouTube URL, wait for the download, and hope the clip quality is acceptable. A proper browser UI could show the suggestions, let you preview audio (or at minimum see the clip metadata), and upload a clip from any source.

**Key design constraint:** voice models are global registry assets, not per-issue. Once "Green Ranger" has a voice model in the registry, every subsequent issue with Green Ranger skips this step entirely. So the casting UI is really about *onboarding new characters* — it fires rarely once the main cast is established.

**Recommended URL:** `/admin/characters/{characterId}/casting` — scoped to a character, not an issue. The pipeline links to this page when it encounters a character without a voice model. After the user completes casting for that character, the pipeline step is unblocked.

**For the voice clip sourcing part:**
- Gemini's suggestions appear as cards with the YouTube link
- User can accept a suggestion → the server downloads via yt-dlp and saves to `comic-voice-clips` bucket
- Or user uploads their own clip directly (file input → `comic-voice-clips` bucket)
- After clip is in the bucket, server triggers ElevenLabs PVC voice model creation
- Status updates while ElevenLabs processes (this takes 1–5 minutes)
- On success: voice model ID saved to `character_appearances` + `castlist` for the current issue

**For yt-dlp server-side:** this runs fine in a Next.js API route or server action — `youtube-dl-exec` is just a child process. No need for a separate worker for this specific step.

The note in the ideas doc about public/paid use is worth preserving: if the app ever serves more than the family, Gemini-suggested sourcing becomes an admin-only tool and regular users rely on pre-built voice models.

---

## Gap 3: Audio Regeneration After Browser Fixes

This gap isn't in the ideas doc explicitly but it's the remaining friction point in the fix cycle after Phase E. The sync runbook in Phase E (`sync-from-db → generate-audio → publish-to-supabase`) still requires three terminal commands after every browser-based fix that touches audio.

**Recommendation: GitHub Actions workflow, triggered after "Apply to DB" succeeds.**

From `future-scope.md`:
- "Apply to DB" POSTs fixes → API route writes to DB + sets `needs_audio=true` on affected bubbles
- API route also fires a `repository_dispatch` event to GitHub
- A GH Actions workflow runs: `sync-from-db` → `generate-audio --flagged-only` → `publish-to-supabase`
- Total lag: ~2 minutes from click to audio live

This is free on personal repos, requires no persistent server, and the 2-minute lag is completely acceptable for a family app. The GitHub Actions workflow has access to all the required secrets (ElevenLabs key, Supabase service role key).

This isn't part of Phase A–E but it's the natural Phase F and should be noted as the next thing to spec after E ships.

---

## Recommended Build Order (Post Phase A–E)

| Priority | Work | Why |
|----------|------|-----|
| 1 | `review-speakers` browser UI (with inline alias creation) | Highest impact; eliminates the most common terminal pause; already specced |
| 2 | `upload-source-pages` script + `/admin/new-issue` upload page | Low effort; unblocks cloud pipeline execution for all subsequent steps |
| 3 | GitHub Actions audio regeneration trigger | Eliminates terminal requirement after browser fixes; free to run |
| 4 | `comic-pages-raw` bucket + cloud-trigger for pipeline steps 2–11 | Depends on #2 being in place; makes the pipeline runnable without local terminal |
| 5 | Casting browser UI (`/admin/characters/{characterId}/casting`) | Most complex; only needed when adding new-to-registry characters |

---

## What Stays Local Forever (And That's Fine)

`scrape-pages` drives a headed browser. Running it locally is a one-command operation that takes about 2 minutes. For a family app where you're the only person adding issues, this is not a problem worth solving — the terminal will always exist for you. Browserbase is worth revisiting if the scope expands.

The local pipeline for steps 1–11 also stays available as a fallback for the entire transition period. Running it locally with `STORAGE_MODE=both` and having the output go to both `public/` and Supabase is the safe migration path. Never delete the local pipeline until Phases A–E are proven stable.
