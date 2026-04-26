# Phase 3 — Automated Comic Image Ingestion (Stagehand)

## Goal
Replace the manual "find image URLs, copy-paste into a markdown file, run python script" workflow with a single command that takes a URL and downloads the pages.

## Why Stagehand Instead of Playwright
Comic sites vary wildly in structure. A raw Playwright approach requires brittle size-heuristic guessing (`naturalWidth > 400`) and custom pagination detection logic per site. Stagehand's `extract()` with a Zod schema lets the AI figure out which images are comic pages regardless of DOM structure, and `act()` handles pagination with natural language ("click the next page button") regardless of how each site implements it. No selector maintenance.

---

## New Command

```bash
# Provide a URL directly
pnpm scrape-pages -- --url "https://..." --book tmnt-mmpr --issue 4

# Interactive mode — prompts for URL if not provided
pnpm scrape-pages -- --book tmnt-mmpr --issue 4
```

**Output:** `assets/comics/<book>/issue-<n>/pages/page-01.jpg` through `page-N.jpg`

---

## New Script: `scripts/scrape-pages.ts`

### Logic

1. **Init Stagehand** with `env: "LOCAL"` (no Browserbase account needed) and `modelName: GEMINI_MEDIUM` (reuses existing Gemini key)
2. **Navigate** to the provided URL and wait for page load
3. **Extract** comic page image URLs using Zod schema:
   ```ts
   const { pages } = await stagehand.extract({
     instruction: "Extract all comic book page image URLs from this page. Include only the full-size page images, not thumbnails, icons, ads, or UI elements.",
     schema: z.object({
       pages: z.array(z.object({
         url: z.string().url().describe("Full URL of the comic page image"),
         pageNumber: z.number().optional().describe("Page number if visible"),
       }))
     })
   });
   ```
4. **Handle pagination**: If fewer than 3 pages found AND a next-page control exists, loop:
   ```ts
   await stagehand.act("click the next page button or arrow");
   // repeat extract, collect URLs until no more pages
   ```
5. **User confirmation**: Print a table of found images and their URLs. Ask: "Found 22 pages. Download? [Y/n]"
6. **Download**: Fetch each image sequentially (avoids rate limiting), save as `page-01.jpg`, `page-02.jpg`, etc.
7. **Report**: Print count + first/last filename

### Fallback
If Stagehand's extraction returns 0 results (canvas rendering, DRM, encrypted sources), print:
```
Could not auto-detect pages. The site may use canvas rendering or DRM.
You can provide image URLs manually via: pnpm download-comic-images
```

---

## Dependencies to Add

```bash
pnpm add @browserbasehq/stagehand
```

Stagehand bundles its own Chromium via Playwright — no separate `playwright install` step needed.

**Config:** Stagehand uses `modelName` + `modelClientOptions` to configure the AI provider. Use Gemini (already in `.env`) to avoid adding a new API key:

```ts
const stagehand = new Stagehand({
  env: "LOCAL",
  modelName: "google/gemini-2.0-flash",  // fast enough for extraction
  modelClientOptions: {
    apiKey: process.env.GEMINI_API_KEY,
  },
});
```

---

## package.json Addition

```json
"scrape-pages": "tsx --env-file=.env scripts/scrape-pages.ts"
```

---

## Integration with Phase 2 Pipeline
In `ingest.ts`, before step 1 (validate-inputs), check if `assets/comics/<book>/issue-<n>/pages/` exists and has images. If not, run `scrape-pages` as a pre-flight step and pause for user confirmation before continuing.

---

## Implementation Steps

1. Add `@browserbasehq/stagehand` as a dependency
2. Create `scripts/scrape-pages.ts` using Stagehand `extract()` + `act()` pattern
3. Add `scrape-pages` to `package.json` scripts
4. Wire the pre-flight check into `ingest.ts` (Phase 2 already done)
5. Test against a known comic URL

## Verification
```bash
pnpm scrape-pages -- --url "<test-url>" --book test --issue 1
# Verify: assets/comics/test/issue-1/pages/ contains sequential page-01.jpg etc.
# Run get-context on one page to confirm format compatibility
pnpm get-context -- --book test --issue 1 --page=1
```
