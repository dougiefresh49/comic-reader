# Future Scope: Cloud Pipeline and Hosted Review

This document captures ideas for moving beyond local-only pipeline execution. None of this is required for the data hosting migration (Phases A–E). Read this after Phase E is stable.

---

## Could the Ingest Pipeline Run in the Cloud?

**Short answer**: the non-interactive steps can. The interactive steps need a UI or separate tooling to replace the terminal prompts.

### Pipeline step breakdown

| Step | Cloud-feasible? | Blocker if not |
|------|----------------|----------------|
| validate-inputs | Yes | Needs source pages in cloud storage |
| generate-pages-metadata | Yes | Needs source pages; outputs pages.json to DB |
| convert-pages-to-webp | Yes | CPU-intensive but stateless |
| get-context (Gemini OCR) | Yes | API call; output to DB |
| **review-speakers** | **No** | Interactive terminal prompt |
| sort-bubbles-gemini | Yes | Gemini API call |
| add-bubble-styles | Yes | Pure computation |
| generate-character-voice-descriptions | Yes | Gemini API call |
| clean-voice-descriptions | Yes | Pure computation |
| **review-new-characters** | **No** | Interactive terminal prompt |
| find-voice-sources | Yes | Gemini API call |
| **generate-voice-models** | **Partial** | Needs human to review + approve YouTube clips |
| generate-audio | Yes | ElevenLabs API; output audio to Storage |
| publish-to-supabase | Yes | Phase D implementation |
| generate-manifest | Yes | DB update only |

### Hosting option: DigitalOcean Droplet

A $6/month Droplet (1 vCPU, 1 GB RAM) is enough to run non-interactive pipeline steps. The droplet would:

1. Poll a job queue (or be triggered by webhook) when new pages are uploaded to a "pending" Storage path
2. Clone the repo and install dependencies
3. Run the automated steps (1–4, 6–8, 13–15)
4. Pause at interactive steps — post a webhook/notification to a Slack channel or email saying "manual review needed"
5. Resume when the user marks the interactive step complete via a web UI or CLI flag

Alternatively, use **GitHub Actions** (free for personal repos) to run pipeline jobs on push or manual trigger. The workflow checks out the repo, installs deps, and runs automated steps. Output is written to Supabase. No persistent server needed.

### Interactive step replacement

**review-speakers** and **review-new-characters** are the main blockers. To make them cloud-compatible:

- **Review page in the existing UI**: Add a "pipeline review mode" to `/review` that shows un-assigned speakers and new characters needing confirmation. User makes decisions in the browser; writes to DB. Pipeline polls the DB for this step's completion flag before proceeding.
- **Slack/email approval**: Generate a summary of unresolved speakers and email it to the user. User replies "approve" or makes edits. Less elegant but simpler to build.

**generate-voice-models** human pause: Same approach — the pipeline creates a task in the DB saying "awaiting voice clip upload for X characters". User uploads clips to Supabase Storage via a UI. Pipeline checks Storage for the clips before proceeding.

---

## Hosted Review Flow (No Local Terminal)

After Phase E, the review UI can apply text/speaker fixes without a terminal. What still requires local access:

1. **Audio regeneration**: ElevenLabs API writes audio files.
2. **OCR re-runs**: Gemini Vision writes to bubbles.
3. **Uploading new audio to Storage**: Needs the mp3 files locally first.

To make this fully hosted:

### Option A: Vercel Edge Functions for Audio

- `/api/regenerate-audio` — calls ElevenLabs API server-side, writes mp3 to Supabase Storage directly.
- Pros: No local step needed.
- Cons: ElevenLabs TTS can take 5–30 seconds per bubble. Vercel functions time out at 60s (Pro) or 300s (Enterprise). For bulk regeneration this won't work. For single-bubble re-gen it's feasible.
- **Verdict**: Fine for fixing one bubble at a time in the review UI. Not viable for full issue regeneration.

### Option B: DigitalOcean Function / Worker

- A long-running worker process listens for `needs_audio=true` rows in the DB.
- Calls ElevenLabs for each bubble, writes mp3 to Storage, updates `audio_timestamps`.
- Clears `needs_audio` flag when done.
- Pros: No timeout limit; bulk handling.
- Cons: Slightly more complex infra. Worker needs ElevenLabs API key.
- **Verdict**: The right approach if you want fully automated audio re-gen after browser-based fixes.

### Option C: GitHub Actions trigger

- After Apply-Fixes API writes to DB, trigger a GitHub Actions workflow via `repository_dispatch`.
- Workflow: checkout repo → `pnpm sync-from-db` → `pnpm generate-audio -- --flagged-only` → `pnpm publish-to-supabase`.
- Pros: No persistent server. GitHub Actions is free for personal repos.
- Cons: 1–3 minute startup lag. Audio files must be passed through Actions artifacts or written directly to Storage.
- **Verdict**: Good pragmatic option. Could implement in Phase E+1 if the "apply fixes then wait 2 minutes" UX is acceptable.

---

## Cost Summary

| Service | Tier | Monthly Cost | What it covers |
|---------|------|-------------|---------------|
| Supabase | Free → Pro ($25) | $0–25 | DB + Storage for ~37 issues on free; Pro covers 100 GB |
| Vercel | Hobby (free) | $0 | Hosting; avoid large file transfers through Vercel functions |
| DigitalOcean Droplet | Basic $6/mo | $6 | Pipeline worker (optional) |
| GitHub Actions | Free tier | $0 | 2000 min/month free; enough for personal use |
| ElevenLabs | Creator ($22/mo) | Already paying | Audio generation |
| **Total** | | **$0–31/mo** | |

Staying on Vercel Hobby + Supabase Free and running the pipeline locally costs $0 extra. Adding a DigitalOcean droplet for cloud pipeline adds $6/mo.
