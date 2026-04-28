# Phase 2 — Pipeline Orchestration (Checkpoint/Resume)

## Goal
Create a single `ingest` command that runs the entire comic processing pipeline with checkpoint/resume support so you can kill it mid-run, come back later, and pick up exactly where you left off.

## Why
Right now every script is run manually. If anything fails (rate limit, crash, API error) you restart from scratch and burn API credits. George's exact suggestion: a pipeline controller with `checkpoint.json`.

---

## New Command

```bash
# Full run for a new issue
pnpm ingest -- --book tmnt-mmpr --issue 4

# Resume from last checkpoint (auto-detected)
pnpm ingest -- --book tmnt-mmpr --issue 4

# Force-restart from a specific step
pnpm ingest -- --book tmnt-mmpr --issue 4 --from-step generate-audio

# Preview what would run without executing
pnpm ingest -- --book tmnt-mmpr --issue 4 --dry-run
```

---

## Pipeline Steps (in order)

| # | Step ID | Script | Notes |
|---|---------|--------|-------|
| 1 | `validate-inputs` | inline check | assets dir + pages exist |
| 2 | `generate-pages-metadata` | `scripts/generate-pages-metadata.ts` | |
| 3 | `convert-pages-to-webp` | `scripts/convert-pages-to-webp.ts` | |
| 4 | `get-context` | `scripts/get-context.ts` | Most expensive — Roboflow + Gemini |
| 5 | `sort-bubbles-gemini` | `scripts/sort-bubbles-gemini.ts` | |
| 6 | `add-bubble-styles` | `scripts/add-bubble-styles.ts` | |
| 7 | `generate-character-voice-descriptions` | `scripts/generate-character-voice-descriptions.ts` | |
| 8 | `clean-voice-descriptions` | `scripts/clean-voice-descriptions.ts` | |
| 9 | `find-voice-sources` | `scripts/find-voice-sources.ts` | **PAUSE** — requires user confirmation (Phase 4) |
| 10 | `generate-voice-models` | `scripts/generate-voice-models.ts` | **PAUSE** — user must verify clips before ElevenLabs |
| 11 | `generate-audio` | `scripts/generate-audio.ts` | Second most expensive |
| 12 | `copy-to-public` | `scripts/copy-to-public.ts` | |
| 13 | `generate-manifest` | `scripts/generate-manifest.ts` | |

Steps 9 and 10 are "human pause" steps — the pipeline stops and prompts the user to confirm before continuing.

---

## Checkpoint File

Location: `assets/comics/<book>/issue-<n>/checkpoint.json`

```json
{
  "book": "tmnt-mmpr",
  "issue": "4",
  "completedSteps": ["validate-inputs", "generate-pages-metadata", "convert-pages-to-webp", "get-context"],
  "lastCompletedAt": "2026-04-25T14:22:00Z",
  "failedStep": null,
  "currentStep": null
}
```

On startup, `ingest.ts`:
1. Reads checkpoint.json if it exists
2. Skips all steps in `completedSteps`
3. Starts from the first non-completed step

---

## New Script: `scripts/ingest.ts`

**Key structure:**
```ts
const PIPELINE_STEPS = [
  { id: "validate-inputs", run: validateInputs },
  { id: "generate-pages-metadata", run: () => runScript("generate-pages-metadata") },
  { id: "get-context", run: () => runScript("get-context") },
  // ...
  { id: "generate-voice-models", run: generateVoiceModels, humanPause: true },
  // ...
];

async function runScript(name: string, args: string[] = []) {
  return execa("pnpm", [name, "--", ...args, `--book=${book}`, `--issue=${issue}`]);
}
```

Each existing script needs to accept `--book` and `--issue` args (or use env vars `COMIC_BOOK` / `COMIC_ISSUE`) so the orchestrator can pass context through.

---

## package.json Addition

```json
"ingest": "tsx --env-file=.env scripts/ingest.ts"
```

---

## Implementation Steps

1. Create `scripts/ingest.ts` with PIPELINE_STEPS array and checkpoint read/write logic
2. Add `--book` and `--issue` arg support to each script (or via env vars — check which pattern existing scripts already use)
3. Add human-pause prompts for steps 9 and 10
4. Add `ingest` to `package.json` scripts
5. Add `checkpoint.json` to `.gitignore` pattern (`assets/**/checkpoint.json`)

## Verification
```bash
# Dry run
pnpm ingest -- --book tmnt-mmpr --issue 3 --dry-run

# Run on an existing issue (all steps already done), verify it detects completion
pnpm ingest -- --book tmnt-mmpr --issue 3

# Simulate resume: manually delete last 2 steps from checkpoint.json, re-run
pnpm ingest -- --book tmnt-mmpr --issue 3
```
