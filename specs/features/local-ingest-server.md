# Feature: Local Ingest Server

## Status: `in-progress`

---

## Purpose

Run the 21-step ingest pipeline from a secondary machine (old laptop) at home, controllable entirely from a phone or browser. No interactive terminal input — all human pauses happen via the existing browser-based review UIs, and progress is tracked in the Supabase `issues` table so the admin dashboard shows live pipeline state.

**Why a local server instead of cloud functions?** The pipeline requires:
- Large file I/O (page images, audio files)
- Long-running processes (Gemini vision, ElevenLabs TTS)
- Local disk for intermediate files (`assets/comics/...`)
- `ffmpeg` and other system tools
- Costs are lower running on existing hardware

---

## Architecture

```
Phone/Browser                    Vercel (admin UI)              Local Server (old laptop)
     |                                |                                |
     |-- POST /api/admin/ingest ------+-----> issues.pipeline_step     |
     |                                |       = "queued"               |
     |                                |                                |
     |                                |   <--- polls /api/admin/       |
     |                                |        ingest-queue            |
     |                                |                                |
     |                                |                                +-- runs pnpm ingest --auto
     |                                |                                |   (updates issues row
     |                                |                                |    after each step)
     |                                |                                |
     |-- GET /admin  (dashboard) -----+--- reads issues.pipeline_step  |
     |   sees "step 7/21: get-context"|                                |
     |                                |                                |
     |-- (pipeline pauses at          |                                |
     |    review-speakers)            |                                |
     |-- clicks /admin/.../review ----+--- pipeline_paused = true      |
     |   does review in browser       |   pipeline_paused_url = "..."  |
     |-- saves review  ---------------+--- pipeline_paused = false     |
     |                                |                                |
     |                                |   <--- detects pause cleared   |
     |                                |                                +-- resumes pipeline
```

### Components

1. **Ingest Worker** (`scripts/ingest-worker.ts`) — a simple HTTP server running on the laptop that:
   - Polls Supabase for issues with `pipeline_step = 'queued'`
   - Pulls source pages from `comic-pages-raw` storage to local disk
   - Runs the existing `pnpm ingest` pipeline in `--auto` mode
   - Updates `issues.pipeline_step` after each step completes
   - Sets `pipeline_paused` + `pipeline_paused_url` when hitting human-pause steps
   - Polls for `pipeline_paused = false` to resume after human review
   - Uploads results back to Supabase Storage when done

2. **Trigger API** (`/api/admin/trigger-ingest`) — Vercel API route that:
   - Sets `issues.pipeline_step = 'queued'` for a given issue
   - The worker picks it up on its next poll cycle

3. **Dashboard updates** — the existing admin dashboard already reads `pipeline_step` and `pipeline_paused` — it will show live status automatically.

---

## Ingest Worker Design

### Polling Loop

```
every 30 seconds:
  1. query issues where pipeline_step = 'queued' AND pipeline_paused = false
  2. if found, pick one (oldest first)
  3. set pipeline_step = 'starting'
  4. pull source pages from comic-pages-raw → local assets/comics/{book}/{issue}/pages/
  5. run each pipeline step sequentially:
     a. update pipeline_step = step.id
     b. spawn pnpm {step.id} -- --book X --issue Y --auto
     c. if exit code 2 (browser pause):
        - set pipeline_paused = true
        - set pipeline_paused_at = step.id
        - set pipeline_paused_url = computed review URL
        - poll every 15s until pipeline_paused = false
        - resume from next step
     d. if exit code 0: mark step complete, continue
     e. if exit code != 0: set pipeline_step = 'failed:{step.id}', stop
  6. on completion: set pipeline_step = 'complete', status = 'ready'
```

### Source Page Download

Before running the pipeline, pull pages from Supabase Storage:
```
comic-pages-raw/{bookId}/{issueId}/source/page-01.jpg → assets/comics/{book}/{issue}/pages/page-01.jpg
```

### Result Upload

After pipeline completes, upload outputs:
```
assets/comics/{book}/{issue}/pages-webp/ → comic-pages/{bookId}/{issueId}/pages/
assets/comics/{book}/{issue}/audio/     → comic-audio/{bookId}/{issueId}/
assets/comics/{book}/{issue}/data/bubbles.json → issue metadata
```

### Health & Status

The worker exposes a simple HTTP endpoint:
- `GET /health` — returns `{ status: "idle" | "running", currentJob?: { book, issue, step } }`

---

## Pipeline Step Changes

### generate-voice-models (human pause)

Currently requires pressing Enter in the terminal. Change to:
- Exit with code 2 (same as review-speakers/review-new-characters)
- Set `pipeline_paused_url` to a new `/admin/{bookId}/{issueId}/review/voices` page
- That page shows the voice model setup status and a "Continue" button
- Clicking "Continue" sets `pipeline_paused = false` in the DB

### Pipeline DB Updates

Each step should update the `issues` row:
```sql
UPDATE issues SET
  pipeline_step = 'get-context',
  pipeline_paused = false
WHERE id = :issueId;
```

The existing `ingest.ts` checkpoint system stays — it's the local resume mechanism. The DB `pipeline_step` is for remote visibility.

---

## Worker Startup

```bash
# On the old laptop
cd ~/projects/comic-reader
pnpm worker
```

The worker script:
1. Loads `.env` for API keys
2. Starts the HTTP health server on port 7777
3. Begins the polling loop
4. Logs all activity to stdout + a rotating log file

### Docker (optional)

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install
COPY . .
EXPOSE 7777
CMD ["pnpm", "worker"]
```

---

## Implementation Plan

### Step 1: Worker Script
- Create `scripts/ingest-worker.ts`
- Poll loop: query Supabase for queued issues
- Download source pages from storage
- Run pipeline steps via `runPnpmScript` (reuse from ingest.ts)
- Update `issues.pipeline_step` after each step
- Handle pause/resume via DB polling
- HTTP health endpoint

### Step 2: Trigger API
- Create `/api/admin/trigger-ingest/route.ts`
- POST: sets `pipeline_step = 'queued'` for given issueId
- Add "Start Pipeline" button to admin dashboard issue actions

### Step 3: Dashboard Integration
- Add pipeline progress display to dashboard (already partially there)
- Add "Start Pipeline" button per issue
- Show pause/resume state with links to review UIs

### Step 4: Voice Model Pause
- Convert `generate-voice-models` to browser-pause pattern (exit code 2)
- Create `/admin/{bookId}/{issueId}/review/voices` page with continue button

---

## Environment Variables (Worker)

The worker needs these in `.env`:
```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ROBOFLOW_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SECRET_KEY=
NEXT_PUBLIC_BASE_URL=      # the Vercel deployment URL, for review page links
WORKER_POLL_INTERVAL=30000 # ms between queue checks
WORKER_PORT=7777
```

---

## Security

- The worker authenticates to Supabase via `SUPABASE_SECRET_KEY` (service role)
- No inbound internet access needed — worker only makes outbound requests
- The trigger API should verify the request is from an authenticated admin
