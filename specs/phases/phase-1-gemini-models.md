# Phase 1 — Gemini Model Updates

## Goal
Centralize all Gemini model strings into a single config file, update to the latest models, and assign each use case to the appropriate cost/speed tier.

## Why
Model strings are hardcoded inline across 5 different files. Two are already stale (`gemini-2.5-flash`, `gemini-3-pro-preview`). When models change again, you'd have to grep every script. One source of truth fixes that permanently.

---

## Model Tiers

```ts
// scripts/utils/models.ts  ← NEW FILE
export const GEMINI_HIGH   = "gemini-3.1-pro-preview";        // deep reasoning, page-level context
export const GEMINI_MEDIUM = "gemini-3-flash-preview";        // vision tasks, OCR, moderate reasoning
export const GEMINI_FAST   = "gemini-3.1-flash-lite"; // simple formatting/validation, no thinking needed
```

**When to use each tier:**
- `GEMINI_HIGH`: Multi-step reasoning about who is speaking, emotion, character type, narrative context — anything that needs the model to "think" about the full page
- `GEMINI_MEDIUM`: Vision tasks (OCR of cropped bubbles, reading order from layout), consolidating descriptions — needs vision + competence, not deep reasoning
- `GEMINI_FAST`: Rule-based fixes like `repair-cues.ts` (applying ElevenLabs cue formatting rules) — repetitive, deterministic, no reasoning needed

---

## Files to Change

| File | Line | Current | New |
|------|------|---------|-----|
| `scripts/utils/gemini-context.ts` | 175 | `"gemini-3-pro-preview"` | `GEMINI_HIGH` |
| `scripts/utils/ocr.ts` | 95 | `"gemini-2.5-flash"` | `GEMINI_MEDIUM` |
| `scripts/sort-bubbles-gemini.ts` | 187 | `"gemini-2.5-flash"` | `GEMINI_MEDIUM` |
| `scripts/generate-character-voice-descriptions.ts` | 104 | `"gemini-2.5-flash"` | `GEMINI_MEDIUM` |
| `scripts/repair-cues.ts` | 229 | `"gemini-2.5-flash"` | `GEMINI_FAST` |

Each file needs: `import { GEMINI_HIGH } from "./utils/models.js"` (or `GEMINI_MEDIUM` / `GEMINI_FAST` as appropriate). Note: `scripts/` uses ES modules with `.js` extensions in imports even for `.ts` source files.

---

## Implementation Steps

1. Create `scripts/utils/models.ts` with the three named exports
2. Update `scripts/utils/gemini-context.ts:175` — import and use `GEMINI_HIGH`
3. Update `scripts/utils/ocr.ts:95` — import and use `GEMINI_MEDIUM`
4. Update `scripts/sort-bubbles-gemini.ts:187` — import and use `GEMINI_MEDIUM`
5. Update `scripts/generate-character-voice-descriptions.ts:104` — import and use `GEMINI_MEDIUM`
6. Update `scripts/repair-cues.ts:229` — import and use `GEMINI_FAST`

## Verification
```bash
pnpm typecheck                                    # no errors
grep -r "gemini-2\|gemini-3-pro" scripts/         # should return nothing
pnpm get-context -- --book tmnt-mmpr --issue 3 --page=1 --skip-gemini  # validate setup without API cost
```
