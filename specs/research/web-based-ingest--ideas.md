# Research: Web-Based Ingest Ideas

**Date:** 2026-04-27  
**Context:** Exploring ideas for a web-based ingest flow that would allow users to ingest new issues and apply fixes to existing issues from the browser. This is a follow-up to the research in `specs/research/path-to-web-based-ingest.md`.

---

## Current Pipeline Steps that are not cloud-ready

| Step                           | What it does                                       | Cloud-ready after migration? | Blocker if no                                                                      |
| ------------------------------ | -------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `scrape-pages`                 | Stagehand drives a browser to download page images | ❌ Stays local               | Drives a headed browser — can't run in a serverless function. Always a local step. |
| 1 `validate-inputs`            | Check assets dir + pages exist                     | ❌ Needs local files         | Depends on source JPEGs being on disk                                              |
| 4.5 `review-speakers`          | Interactive terminal: accept/edit speaker names    | ❌ Needs browser UI          | Already specced (`review-speakers.md`) — a natural review UI page                  |
| 8.5 `interactive-alias-review` | Interactive terminal: confirm/create aliases       | ❌ Needs browser UI          | Specced as `pending` in features.md — guided menu for new character names          |
| 9 `find-voice-sources`         | Gemini researches voice clips; user picks source   | ❌ Needs browser UI          | The "casting" flow — rich enough to warrant its own review page                    |

## Ideas for web-based ingest

### Gap 1: Source JPEG Upload

Steps 1–3 all assume JPEGs are on the local filesystem. To trigger the pipeline from the browser, pages need to enter the system through a different path.

**Option A — Upload at start of pipeline:**  
A browser upload UI (`/admin/new-issue`) lets you drag-and-drop page JPEGs directly into a `comic-pages-raw` private bucket. Steps 2–3 run server-side as a background job (Next.js server action or a Vercel function) reading from that bucket.

**Option B — Scrape then upload (semi-local):**  
Keep `scrape-pages` local (it drives a browser, that's fine). After scraping, a short script uploads the downloaded JPEGs to `comic-pages-raw` and triggers the rest of the pipeline via API. The only local step is the actual scrape.

**Option C — Chrome extension:**  
A Chrome extension that allows users to drag-and-drop page JPEGs directly into a `comic-pages-raw` private bucket. The extension would be able to run the scrape-pages script programmatically, but if we were ever to move to a different way to gather the source files, we would still need the option to manually upload the source files to the bucket via the extension.

**Option D — Some type of kindle integration:**  
A Kindle integration that allows users to allow the app to access their Kindle library and upload the pages to the `comic-pages-raw` private bucket. This would be a more seamless experience for users who already have their comics on Kindle or other e-reader devices. This is more of a future feature, for now, we will focus on other options and keeping the app for family use only.

#### Summary of Options

Option B is lower friction to implement and keeps the architecture clean — `scrape-pages` stays a local tool, everything after is cloud. But it does require the user to have a local copy of the codebase and to run the scrape-pages script. There is another option, and that would be browser-based, which is a hosted version of stagehand. The app would be able to run the scrape step programmatically, but if we were ever to move to a different way to gather the source files, we would still need the option to manually upload the source files to the bucket via the browser. I put the browser-based pricing page link and a markdown table of their pricing and features below.

#### Browserbase Pricing and Features

[Browser-based pricing page](https://www.browser-based.com/pricing)

| **Feature**                    | **Start for Free**      | **Get Developer**                                  | **Get Startup**                                       | **Contact Sales**            |
| :----------------------------- | :---------------------- | :------------------------------------------------- | :---------------------------------------------------- | :--------------------------- |
| **Infrastructure**             |                         |                                                    |                                                       |                              |
| Concurrency                    | 3                       | 25                                                 | 100                                                   | 250+                         |
| Browser Hours                  | 1                       | 100 then \$0.12/browser hr                         | 500 then \$0.10/browser hr                            | Usage-based                  |
| Search API                     | 1,000                   | 1,000 (\$7/1k requests)                            | 1,000 (\$7/1k requests)                               | Usage-based                  |
| Search RPS (per project)       | 2                       | 2                                                  | 2                                                     | Custom                       |
| Fetch API                      | 1,000                   | 1,000 then \$1/1k calls ($4/1k calls with proxies) | 10,000 then \$0.5/1k calls ($4/1k calls with proxies) | Usage-based                  |
| Fetch RPS (per project)        | 5                       | 5                                                  | 5                                                     | Custom                       |
| **Capabilities**               |                         |                                                    |                                                       |                              |
| Runtime: Browserbase Functions | ✓                       | ✓                                                  | ✓                                                     | ✓                            |
| Captcha Solving                | —                       | ✓                                                  | ✓                                                     | ✓                            |
| Data Retention                 | 7 days                  | 30 days                                            | 30 days                                               | 30+ days                     |
| Model Gateway                  | \$5 in models in tokens | Pay as you go (Market price)                       | Pay as you go (Market price)                          | Pay as you go (Market price) |
| Stealth Mode                   | —                       | Basic                                              | Basic                                                 | Advanced                     |

### Gap 2: Interactive Terminal Steps Need Browser UIs

Three pipeline steps are interactive menus that pause and wait for user input:

**`review-speakers` (step 4.5)** — already specced in `specs/features/review-speakers.md`. The natural home is a `/admin/issue/{bookId}/{issueId}/review/speakers` page that shows each AI-assigned speaker name with [Accept / Edit / Choose from list] options. Auto-accepts known registry characters. This is probably the most straightforward to build.

**`interactive-alias-review` (step 8.5)** — specced as `pending` in features.md. Shows new character names detected during ingestion. [1] Create new character / [2] Alias to existing list. Should prune stale characters against bubbles.json first. A simple modal or side panel in the admin review flow would cover this. This would be a `/admin/issue/{bookId}/{issueId}/review/aliases` page.

**`find-voice-sources` (step 9)**

- the "casting" step. Gemini suggests voice clip sources (YouTube, etc.), user picks one, then ElevenLabs creates the IVC voice model. This is the richest interactive step — it probably deserves its own dedicated `/admin/issue/{bookId}/{issueId}/review/casting` page. Note: this is also the step most dependent on the user's taste/judgment, so the UI needs to be good.

- if the app was ever released for public or paid use, this would be a paid feature and the user would just rely on the app to do the work or app admins to do the audio farming. For now, this will just be me as the uploader and audio farmer. But keep the concept of Gemini finding voice sources and user picking the source and providing the audio back to the app (or in elevenlabs if that would be a better fit).
