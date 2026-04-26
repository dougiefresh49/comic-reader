# Feature: Book-Aware Context for Character Identification

## Status: `pending`
## Prerequisite: None — independent of other pending features
## Priority: High — fixes character misidentification and wasted research calls on every new issue

---

## Problem

`get-context.ts` processes each comic page in isolation. Gemini has no knowledge of:

1. **What franchise/universe this comic is from** — so it invents descriptors like "Winged Monster" instead of identifying Goldar, a well-known Power Rangers villain it already knows from training data.
2. **Which characters have already appeared in this book** — so the same character gets different names on different pages ("Green Dimension X Ranger" on page 17, "Villain Green Ranger" on page 18).
3. **Which characters are named vs generic** — so `find-voice-sources` wastes Gemini API calls researching "Female Soldier" and "Unknown Voice" as if they were named characters with media appearances.

---

## Solution Overview

Three components, all building toward a single goal: give `get-context.ts` the context a human reader would naturally have.

| Component | File | Solves |
|-----------|------|--------|
| Book config | `assets/comics/<book>/book-config.json` | Franchise identity + wiki reference |
| Character roster | `assets/comics/<book>/character-roster.json` | Cross-page/cross-issue name consistency |
| Character classification | field on `new-characters.json` | Skip research for generic characters |

---

## Component 1: `book-config.json`

Lives at `assets/comics/<book>/book-config.json`. Created manually when a new book is set up. Committed to git.

### Schema

```json
{
  "title": "Mighty Morphin Power Rangers / Teenage Mutant Ninja Turtles III",
  "franchises": ["Teenage Mutant Ninja Turtles", "Mighty Morphin Power Rangers"],
  "characterContext": "Use your knowledge of both franchises to identify characters by their proper canonical names (e.g. Goldar, Shredder, Leonardo, Tommy Oliver, Zordon, Lord Zedd). Only use a descriptive name as a last resort for characters who are genuinely unnamed in the source material.",
  "wikiUrls": {
    "issue-1": "https://powerrangers.fandom.com/wiki/MMPR/TMNT_III_Issue_1",
    "issue-2": "https://powerrangers.fandom.com/wiki/MMPR/TMNT_III_Issue_2",
    "issue-3": "https://powerrangers.fandom.com/wiki/MMPR/TMNT_III_Issue_3"
  }
}
```

For a Sonic book:

```json
{
  "title": "Sonic the Hedgehog",
  "franchises": ["Sonic the Hedgehog"],
  "characterContext": "Use your knowledge of the Sonic the Hedgehog universe to identify characters by their canonical names (e.g. Sonic, Tails, Knuckles, Dr. Eggman, Shadow, Rouge, Amy Rose).",
  "wikiUrls": {}
}
```

### Fallback behavior

If `book-config.json` does not exist, `get-context.ts` falls back to a generic instruction:

> *"Use your knowledge of comics and pop culture to identify characters by their proper canonical names where possible."*

This ensures existing books (and books set up before this feature) don't break.

---

## Component 2: `character-roster.json`

Lives at `assets/comics/<book>/character-roster.json`. Built automatically as pages are processed, and manually editable to correct misidentifications. Committed to git.

### Schema

```json
{
  "Goldar": {
    "canonicalName": "Goldar",
    "aliases": ["Winged Monster", "Golden Armored Villain"],
    "description": "Golden-armored winged simian warrior. Villain serving Lord Zedd and Rita Repulsa.",
    "franchise": "Power Rangers",
    "firstSeenIssue": "issue-3",
    "firstSeenPage": 8
  },
  "Green Dimension X Ranger": {
    "canonicalName": "Green Dimension X Ranger",
    "aliases": ["Villain Green Ranger", "Kala"],
    "description": "Female ranger in green Dimension X armor. Ally of TMNT and the main Power Rangers team.",
    "franchise": "Power Rangers / TMNT",
    "firstSeenIssue": "issue-3",
    "firstSeenPage": 17
  }
}
```

### How it's built

During `get-context.ts`, after each page is processed, any new character names found in the page's bubbles are added to the roster with:
- `canonicalName`: the name Gemini assigned
- `description`: pulled from the voice description Gemini generated for that character
- `firstSeenIssue` / `firstSeenPage`: current issue/page
- `aliases`: empty initially; populated manually or via alias resolution

The roster is read-before-write on each page, so it accumulates across the entire issue run. Because it's book-level, it also carries forward to future issues.

### How it's injected into the prompt

The roster is formatted and appended to the Gemini context for each page call:

```
Characters already identified in this book (use these exact canonical names if you see them):
- Goldar: Golden-armored winged simian warrior. Also goes by: Winged Monster
- Green Dimension X Ranger: Female ranger in green Dimension X armor. Also goes by: Villain Green Ranger, Kala
- Leonardo: Blue-masked TMNT leader with twin katana.
```

### Alias resolution

The `aliases` array on each roster entry feeds directly into `scripts/alias-map.ts` normalization. A helper in `get-context.ts` (or a new `scripts/utils/roster.ts`) reads the roster at pipeline start and programmatically registers all aliases, so `clean-voice-descriptions.ts` collapses them automatically without manual `alias-map.ts` edits.

### Manual corrections

The roster is a plain JSON file. If Gemini names a character wrong across pages, the user can:
1. Edit `character-roster.json` — add the wrong name to `aliases`, set `canonicalName` to the correct name
2. Re-run `clean-voice-descriptions` to collapse aliases
3. The next issue run will use the corrected canonical name from the start

---

## Component 3: Character Classification

### Problem

`find-voice-sources.ts` currently researches every character in `new-characters.json` — including purely generic ones like "Female Soldier", "Unknown Voice", "Robo-Foot Soldier" — which wastes Gemini API calls and produces 0 results.

### Solution

Add a `named` boolean to each entry in `new-characters.json` during `clean-voice-descriptions.ts`. Named characters go through the full research flow. Generic characters skip directly to Voice Design.

### Classification logic

During `generate-character-voice-descriptions`, Gemini already has a list of all characters and their voice descriptions. At the same time, ask it to classify each one:

```
For each character, also output whether they are a "named" character (has a specific proper
name from the source franchise — e.g. Goldar, Baxter Stockman) or "generic" (described only
by role or appearance — e.g. "Female Soldier", "Unknown Voice", "Robo-Foot Soldier").
```

`new-characters.json` output with classification:

```json
{
  "Goldar": {
    "description": "A deep, booming authoritative voice...",
    "named": true
  },
  "Baxter Stockman": {
    "description": "A sharp, nasally male voice...",
    "named": true
  },
  "Female Soldier": {
    "description": "An authoritative, mid-30s female voice...",
    "named": false
  },
  "Unknown Voice": {
    "description": "A deep, commanding voice...",
    "named": false
  }
}
```

### Pipeline behavior

In `find-voice-sources.ts`:
- `named: true` → research appearances → user picks voice → IVC or Voice Design
- `named: false` → skip research, go straight to Voice Design using the existing description

In `generate-voice-models.ts`:
- No change needed — it already handles both IVC and Voice Design paths

---

## Wiki URL Context

When `wikiUrls[issueId]` is set in `book-config.json`, fetch the page content at the start of the `get-context.ts` run and include it as reference text in the Gemini prompt:

```
Reference — issue wiki page (use for character identification):
[fetched text content of the wiki page]
```

Fetch using Node `https` (same pattern as `downloadFile` in `scrape-pages.ts`). Strip HTML tags, keep plain text. Cache the result in `assets/comics/<book>/issue-<n>/data/wiki-cache.txt` so it isn't re-fetched on pipeline resume.

This gives Gemini a character list, plot summary, and named appearances for the specific issue — most useful for characters that are lore-correct but visually ambiguous.

---

## Pipeline Changes Summary

### `scripts/get-context.ts`

1. Load `book-config.json` if present (fallback to generic instruction if not)
2. Load `character-roster.json` if present (fallback to empty)
3. Fetch and cache wiki page if `wikiUrls[issueId]` is set
4. Inject `characterContext` + formatted roster + wiki text into each page's Gemini prompt
5. After each page: update roster with any new character names found in the page's bubbles

### `scripts/generate-character-voice-descriptions.ts`

1. Add classification prompt: for each character, output `named: true/false`
2. Pass `characterContext` from `book-config.json` to improve description quality

### `scripts/clean-voice-descriptions.ts`

1. Write `named` field through to `new-characters.json`
2. Load roster aliases and register them programmatically (so `alias-map` collapses them)

### `scripts/find-voice-sources.ts`

1. Skip research for characters where `named: false`
2. Auto-assign Voice Design path for generic characters, log them clearly

---

## New File: `scripts/utils/roster.ts`

Shared helper for reading/writing the character roster:

```ts
export function loadRoster(bookDir: string): CharacterRoster
export function saveRoster(bookDir: string, roster: CharacterRoster): Promise<void>
export function formatRosterForPrompt(roster: CharacterRoster): string
export function addCharacterToRoster(roster: CharacterRoster, name: string, issue: string, page: number): CharacterRoster
export function getRosterAliasMap(roster: CharacterRoster): Record<string, string>  // alias → canonicalName
```

---

## File Locations

```
assets/comics/<book>/
  book-config.json              ← franchise context, wiki URLs (manual, committed)
  character-roster.json         ← running character identity (auto-built + manual, committed)

assets/comics/<book>/issue-<n>/data/
  wiki-cache.txt                ← fetched wiki content (gitignored)
```

---

## Implementation Steps

1. Define `BookConfig` and `CharacterRoster` types in `scripts/types/` (or inline in `roster.ts`)
2. Create `scripts/utils/roster.ts` — load/save/format/alias helpers
3. Create `assets/comics/tmnt-mmpr-iii/book-config.json` with TMNT/MMPR context and wiki URLs
4. Create `assets/comics/tmnt-mmpr-iii/character-roster.json` as `{}` (will be populated on next run)
5. Update `scripts/get-context.ts`:
   - Load book-config + roster at start of run
   - Fetch + cache wiki content if URL present
   - Inject all three into each page prompt
   - Update roster after each page
6. Update `scripts/generate-character-voice-descriptions.ts` — add `named` classification to output
7. Update `scripts/clean-voice-descriptions.ts` — pass through `named` field; apply roster aliases
8. Update `scripts/find-voice-sources.ts` — skip research for `named: false`, route to Voice Design
9. Add `book-config.json` and `character-roster.json` to `specs/features/features.md`

## Key Files to Read Before Implementing

- `scripts/get-context.ts` — page processing loop and Gemini prompt structure
- `scripts/generate-character-voice-descriptions.ts` — where to add classification
- `scripts/clean-voice-descriptions.ts` — alias normalization flow
- `scripts/find-voice-sources.ts` — research skip logic goes here
- `scripts/alias-map.ts` — existing alias normalization, roster aliases feed into this
- `scripts/utils/models.ts` — model tier constants
- `assets/comics/tmnt-mmpr-iii/issue-3/new-characters.json` — concrete example of what needs classifying

---

## Verification

```bash
# After implementation, re-run issue 3 get-context from scratch
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step get-context

# Expect:
# - "Goldar" appears in bubbles.json instead of "Winged Monster"
# - "Green Dimension X Ranger" used consistently across all pages
# - character-roster.json populated with all issue-3 characters

# Check classification output
cat assets/comics/tmnt-mmpr-iii/issue-3/new-characters.json
# Expect: "Goldar": { named: true }, "Female Soldier": { named: false }

# Check find-voice-sources skips generics
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --from-step find-voice-sources
# Expect: "Female Soldier", "Unknown Voice" etc. logged as "generic — skipping research, using Voice Design"

pnpm typecheck
```
