# Comic Reader

Personal "Audible + Kindle for comics" app. Kids learning to read get an interactive comic viewer where tapping a speech bubble plays the character's voice and highlights words in sync (karaoke-style). Not for sale — family use only.

Currently live with 2 TMNT x MMPR issues. Goal is to make adding new books fast enough to do regularly.

---

## Tech Stack

- **Frontend**: Next.js 15 App Router, React 19, Tailwind CSS
- **Bubble detection**: Roboflow rapid model (bounding boxes)
- **OCR + Context**: Google Gemini (`@google/genai`)
- **Voice**: ElevenLabs (PVC for main characters, Voice Design for minor/auto characters)
- **Image processing**: `sharp` (JPEG → WebP)
- **Downloads**: `youtube-dl-exec`
- **Deployed**: Vercel (known issue: images in `public/` will need S3/Blob migration)

---

## Pipeline Flow

Each book+issue goes through these steps in order. Run via `pnpm ingest -- --book <name> --issue <n>` (after Phase 2).

| Step | Script | What it does |
|------|--------|-------------|
| 1 | validate-inputs | Check assets dir + pages exist |
| 2 | generate-pages-metadata | Extract page dimensions → `pages.json` |
| 3 | convert-pages-to-webp | JPEG pages → WebP → `pages-webp/` |
| 3.5 | fetch-wiki-context | MediaWiki API → `issues.wiki_summary` + `issues.wiki_appearances` |
| 4 | get-context | Roboflow bounding boxes + Gemini OCR + speaker/emotion context → `bubbles.json` |
| 5 | sort-bubbles-gemini | AI reorders bubbles for correct reading order |
| 6 | add-bubble-styles | Calculate % coordinates for responsive positioning |
| 7 | generate-character-voice-descriptions | Gemini consolidates voice descriptions per character |
| 8 | clean-voice-descriptions | Normalize character names via alias-map → `source-material.json` |
| 9 | find-voice-sources | *(Phase 4)* Gemini researches media appearances → user picks voice |
| 10 | generate-voice-models | ElevenLabs creates voice models from clips → `castlist.json` |
| 11 | generate-audio | ElevenLabs TTS for every bubble → `audio/` + `audio-timestamps.json` |
| 12 | copy-to-public | Stage WebP + audio → `public/comics/` for Next.js serving |
| 13 | generate-manifest | Final `manifest.json` + `src/data/manifest.ts` |

**Manual scripts** (run as needed, not part of main pipeline):
- `repair-cues` — fix ElevenLabs textWithCues formatting after bulk generation
- `backfill-context` — add missing aiReasoning fields to existing bubbles.json
- `regenerate-timestamps` — re-fetch timestamps without re-generating audio
- `apply-fixes` — apply corrections from the web review interface
- `split-voice` — isolate character voice from mixed audio (source separation + diarization + Gemini ID)

---

## Gemini Model Tiers

After Phase 1, all model strings live in `scripts/utils/models.ts`.

| Export | Model | Use when |
|--------|-------|---------|
| `GEMINI_HIGH` | `gemini-3.1-pro-preview` | Page-level context: speaker ID, emotion, narrative context — needs reasoning |
| `GEMINI_MEDIUM` | `gemini-3-flash-preview` | Vision tasks: OCR, reading order sorting, voice description consolidation |
| `GEMINI_FAST` | `gemini-3.1-flash-lite` | Rule-based tasks: cue formatting fixes, simple validation — no reasoning needed |

Never hardcode model strings inline. Always import from `scripts/utils/models.ts`.

---

## Directory Layout

```
assets/comics/<book>/issue-<n>/
  pages/                    ← INPUT: source JPEGs (not in public)
  pages-webp/               ← intermediate WebP before copy-to-public
  data/
    bubbles.json            ← speech bubble data (coordinates, speaker, text, audio)
    pages.json              ← page dimensions
    character-voice-descriptions.json
    voice-sourcing-suggestions.json  ← Phase 4 output
    castlist.json           ← character → ElevenLabs voice ID
    source-material.json    ← character → voice clip source
    audio-timestamps.json   ← ElevenLabs word alignment data
    gemini-context/         ← per-page Gemini analysis cache
  audio/                    ← generated .mp3 files
  checkpoint.json           ← pipeline progress (gitignored)

public/comics/<book>/issue-<n>/
  pages/                    ← OUTPUT: WebP images served by Next.js
  audio/                    ← OUTPUT: MP3 files served by Next.js
  bubbles.json
  manifest.json

data/                       ← global data (alias-map, source-material overrides)
scripts/                    ← all processing scripts
scripts/utils/              ← shared utilities (Gemini, Roboflow, OCR, image math)
src/                        ← Next.js app
```

---

## Key Environment Variables

Set in `.env` (used by `--env-file=.env` flag in all script commands):

```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ROBOFLOW_API_KEY=
NEXT_PUBLIC_BASE_URL=
```

For Claude Code personal settings: copy `.claude/settings.local.json.example` → `.claude/settings.local.json` and fill in keys.

---

## Common Commands

```bash
# Add a new comic (after Phase 2 + 3)
pnpm scrape-pages -- --url <url> --book <name> --issue <n>
pnpm ingest -- --book <name> --issue <n>

# Resume a stalled pipeline run
pnpm ingest -- --book <name> --issue <n>  # auto-resumes from checkpoint

# Force restart from a specific step
pnpm ingest -- --book <name> --issue <n> --from-step generate-audio

# Fix specific bubbles after human review
pnpm apply-fixes  # reads fixes.json exported from the web review UI

# Dev server
pnpm dev

# Type check
pnpm typecheck
```

---

## Code style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- Structured data lives in Supabase (DB + Storage) — don't introduce new local JSON state files; the `assets/` JSON files are legacy from the local pipeline era.

---

## General preferences

- Use pnpm, never npm.
- Delegation roster: cursor-agent, codex, and Claude models only. Don't delegate to agy/Antigravity (owner call, 2026-07-07 — flaky headless behavior).
- If asked to do too much work at once, stop and state that clearly.
- If computer use is helpful for completing or verifying work, prefer the claude-in-chrome MCP for plain web-page checks (this is a web app); shell out to gpt-5.x with Codex (see the `codex-computer-use` skill) for anything needing native UI, audio playback confirmation, or an independent second pair of eyes.

---

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what we actually pay (subscriptions with generous limits rank cheap), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model        | cost | intelligence | taste | reachable via                    |
| ------------ | ---- | ------------ | ----- | -------------------------------- |
| composer-2.5 | 8    | 5            | 5     | cursor-agent CLI (`agent`)       |
| grok-4.5     | 8    | 6            | 6     | cursor-agent CLI (`--model grok-4.5-fast-xhigh`; everyday tier `-fast-high`) |
| gpt-5.x      | 8    | 7            | 5     | codex CLI (`codex`)              |
| sonnet-5     | 5    | 5            | 7     | Agent/Workflow `model: 'sonnet'` |
| opus-4.8     | 4    | 7            | 8     | Agent/Workflow `model: 'opus'`   |
| fable-5      | 2    | 9            | 9     | Agent/Workflow `model: 'fable'`  |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, formatting sweeps, migrations, batch refactors): composer-2.5 or grok-4.5 via cursor-agent (grok audition 2026-07-08: passed a 9-file cross-module task with distinction; prefer grok for trickier multi-file work, composer for pure mechanical) — it's effectively free and runs in an isolated worktree while you keep working.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7: sonnet-5 minimum, opus-4.8/fable-5 preferred. The Gemini prompts in the pipeline (speaker ID, voice descriptions, reading order) directly shape what kids hear and read — treat prompt edits as user-facing work.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally composer-2.5 or gpt-5.x as an extra independent perspective (see the `codex-review` skill).
- Never use Haiku. For trivial work (classification, log filtering, glue, bulk edits), use composer-2.5 or gpt-5.x — they're effectively free and better.

Mechanics:

- **Check CLI availability before delegating** — not every machine has every CLI. `command -v agent` for cursor-agent, `command -v codex` for codex. If the CLI you want is missing, fall back to a Claude subagent via the Agent tool instead of telling the user to install anything.
- composer-2.5 runs through the cursor-agent CLI: `agent --worktree -p --force "prompt"` (see the `cursor-agent` skill for full flags, spec-file workflow, and output formats). Always pass `--force` for tasks that write code; default model is composer, or pin with `--model composer-2.5`.
- gpt-5.x runs through the codex CLI — `codex exec` / `codex review`. On this machine codex has the computer-use plugin set up and MCP servers connected (verify with `codex mcp list` if a task depends on a specific one). Use the `codex-review` and `codex-computer-use` skills; for work they don't cover (investigation, data analysis), run `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet, opus, fable) run via the Agent/Workflow `model` parameter — no CLI needed.
- Codex runs can exceed Bash's 10-minute timeout: pass an explicit timeout, or run in the background and poll for the report file.
- Parallel implementation agents that write code must use `isolation: 'worktree'` so edits don't collide in the shared checkout.

Repo-specific rules for delegated agents:

- Every checkout/worktree needs a valid `.env` before dev, build, or pipeline scripts run — Next.js validates env vars with Zod at config load (`src/env.mjs`), and all pipeline scripts use `tsx --env-file=.env`. Worktrees (including cursor-agent's at `~/.cursor/worktrees/`) do NOT inherit `.env` — tell the agent to copy it from the source checkout first.
- Do not use `SKIP_ENV_VALIDATION=1` for normal verification — it's for CI/Docker builds only.
- Delegated agents must NOT make live Gemini/ElevenLabs/Roboflow calls unless the task is explicitly about pipeline processing — ElevenLabs credits especially are real money. State this in every delegated prompt.
- Delegated agents must run `pnpm format:write` (or `prettier --write` on changed files) before committing.
- Verification gate for any delegated code task: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` — all clean before handing work back. (No test suite in this repo yet.)

---

## Verifying this app

The app is a Next.js web app, so most verification is browser-based:

1. `pnpm dev` (needs valid `.env`), then check the reader at `/book/<bookId>/<issueId>` and admin at `/admin`.
2. Claude can drive the browser directly via the claude-in-chrome MCP — prefer that for page checks, console errors, and screenshots.
3. Audio playback confirmation ("does tapping a bubble actually play the right voice with word highlighting") benefits from real eyes/ears — shell out via the `codex-computer-use` skill.
4. Prefer checking DB rows and Supabase Storage over re-running pipeline steps — pipeline runs cost Gemini/ElevenLabs/Roboflow credits.
5. Production checks: Vercel MCP for deployment status and runtime logs; Supabase MCP for data.

Launching the dev server, taking screenshots, and playing short test audio are fine without asking; ask first before anything that mutates production data, resets pipeline state, or triggers paid pipeline runs.

---

## Roadmap

The end-state vision and phased plan tying every workstream together
lives in **[specs/roadmap/00-overview.md](specs/roadmap/00-overview.md)**.
Open this first if you want context on where things are going. Sub-docs:

| File | What it covers |
|---|---|
| [00-overview.md](specs/roadmap/00-overview.md) | North-star, current state, end-state diagram, phased plan |
| [01-data-model.md](specs/roadmap/01-data-model.md) | Canonical DB schema (existing + planned) |
| [02-ingest-pipeline.md](specs/roadmap/02-ingest-pipeline.md) | End-state ingest with new steps (wiki, segmentation, lookahead, music scenes) |
| [03-reader-experience.md](specs/roadmap/03-reader-experience.md) | Layered render, transitions, chrome, captions |
| [04-voice-rotation.md](specs/roadmap/04-voice-rotation.md) | IVC archive/restore + fidelity test recipe |
| [05-admin-tooling.md](specs/roadmap/05-admin-tooling.md) | Admin UI gaps and additions per workstream |

## Phase Plan Index

Improvements are broken into phases. Run each in a new Claude session with `/clear` between phases.

| Phase | Spec | Status |
|-------|------|--------|
| 0 | [specs/phases/phase-0-hooks.md](specs/phases/phase-0-hooks.md) | ✅ Done |
| 1 | [specs/phases/phase-1-gemini-models.md](specs/phases/phase-1-gemini-models.md) | ✅ Done |
| 2 | [specs/phases/phase-2-pipeline.md](specs/phases/phase-2-pipeline.md) | ✅ Done |
| 3 | [specs/phases/phase-3-image-ingestion.md](specs/phases/phase-3-image-ingestion.md) | ✅ Done (Stagehand + GEMINI_MEDIUM) |
| 4 | [specs/phases/phase-4-voice-sourcing.md](specs/phases/phase-4-voice-sourcing.md) | ✅ Done |
| 5 | [specs/phases/phase-5-reader-refactor.md](specs/phases/phase-5-reader-refactor.md) | ✅ Done |

---

## Feature Tracker

New features and backlog items live in `specs/features/`. Check here before starting any new feature work.

**[specs/features/features.md](specs/features/features.md)** — the canonical tracker. Statuses: `pending` · `in-progress` · `done` · `blocked`. Update this file when work starts or completes.

Each feature has its own spec file in `specs/features/`:

| Feature | Status | Spec |
|---------|--------|------|
| Global character registry | `pending` | [specs/features/character-registry.md](specs/features/character-registry.md) |
| Review UI — annotation editor | `pending` | [specs/features/review-ui-phase-a.md](specs/features/review-ui-phase-a.md) |
| Review UI — live regeneration | `blocked` (needs storage migration) | [specs/features/review-ui-phase-b.md](specs/features/review-ui-phase-b.md) |

When implementing a feature: read its spec file, implement only what's in that spec, then update the status in `features.md`.

---

## Known Issues / Technical Debt

- `src/components/ZenComicReader.tsx` refactored (Phase 5 complete) — logic lives in `src/hooks/`
- Layered panel rendering uses SVG clip-paths with SAM3 foreground polygons — effects render between bg and fg
- `public/` folder image storage won't scale on Vercel (Phase 2 `STORAGE_MODE=s3` flag exists but isn't wired up)
- Some one-off scripts in `scripts/` are patches for gaps in the pipeline (backfill-context, repair-cues, regenerate-timestamps) — these become less necessary once Phase 2 pipeline runs cleanly end-to-end
- Roboflow model may benefit from re-training (has improved since initial setup)
