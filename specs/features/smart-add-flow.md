# Feature: Smart Add Flow

## Status: `pending`
## Prerequisite: Book Parts migration ([book-parts.md](book-parts.md))

---

## Problem

Adding a new book or issue today requires manual hunting across multiple browser tabs:

1. Google the comic to find its fandom wiki page
2. Copy the wiki URL into `book-config.json`
3. Google "read [comic name] online" to find a source for page images
4. Copy that URL into `pnpm scrape-pages -- --url <url> --book <id> --issue <n>`
5. Run the command in terminal

This is 5-10 minutes of tab-switching and copy-pasting per issue. For a 5-issue book, that's ~30 minutes of busywork before any pipeline processing begins.

---

## Solution

Replace the manual lookup steps with an AI-assisted browser flow in the admin dashboard. Two entry points:

### Flow 1: Add Next Issue (existing book)

For books already in the system. The wiki and book config already exist — we just need the next issue.

```
/admin/add-issue?book=tmnt-mmpr
```

**Steps:**

1. **Select part (if applicable)** — If the book has `book_parts`, show a dropdown to select which part. For flat series (Sonic), skip this step. The part determines the issue numbering scope.

2. **Auto-detect next issue number** — Query `issues` table for the book (and part, if selected), find the highest issue number, suggest `n+1`. Show "Issue 4 of 5" if `total_issues` is known.

3. **Wiki lookup** — Use the book's `wiki_host` + `wiki_title_template` (or the part's `wiki_url` pattern) to construct the wiki URL for the next issue. If the template doesn't cover it, use the fandom wiki API to search for the issue page. Show the URL for user confirmation.

4. **Source lookup** — Call Gemini 3.1 Flash with Google Search grounding:
   > "Find a URL where I can read [book title] Issue [n] online for free. Return only the most likely direct URL."
   
   Show the result for user confirmation. User can also paste their own URL.

5. **Confirm and queue** — Save the wiki URL and source URL to the issue record. The issue's `part_id` is set if a part was selected. User has two options:
   - **"Download Pages"** — triggers `scrape-pages` via a server action (Stagehand runs server-side)
   - **"Copy command"** — shows the terminal command for manual execution

### Flow 2: Add New Book

For books not yet in the system. Needs discovery of the book itself.

```
/admin/add-book
```

**Steps:**

1. **Search** — Free-text input. User types something like "TMNT He-Man crossover comic" or "batman tmnt adventures". Call Gemini 3.1 Flash with Google Search grounding:
   > "Find the fandom wiki page for the comic book series: [query]. Return the wiki URL, full title, publisher, issue count, and franchise names."
   
   Display results as a confirmation card:
   ```
   Mighty Morphin Power Rangers / Teenage Mutant Ninja Turtles
   Publisher: BOOM! Studios / IDW Publishing
   Issues: 5
   Franchises: TMNT, Power Rangers
   Wiki: https://powerrangers.fandom.com/wiki/...
   
   [Confirm] [Search again]
   ```

2. **Generate book config** — On confirm, auto-generate:
   - `books` DB row with name, slug, wiki_host, wiki_title_template, publisher, franchises, total_issues
   - `book_parts` rows if Gemini detected parts (with name, number, wiki_url per part)
   - `book-config.json` with title, franchises, characterContext, and wikiUrls or parts structure

3. **Add first issue** — Redirect to Flow 1 with the new book ID pre-filled (and part pre-selected if parts exist).

---

## Data Model

See [book-parts.md](book-parts.md) for the full schema spec. Summary of what Smart Add needs:

### From Book Parts migration

- `book_parts` table — optional sub-grouping for multi-part series
- `books.wiki_host`, `books.wiki_title_template`, `books.total_issues`, `books.publisher`, `books.franchises`
- `issues.part_id` (nullable FK to `book_parts`)
- `issues.source_url`, `issues.wiki_url`

---

## Gemini Integration

All lookups use **Gemini 3.1 Flash** (`GEMINI_MEDIUM`) — fast, cheap, good at web knowledge.

### Search grounding

Gemini's Google Search grounding is the key enabler. It lets us do web searches without a separate Google Search API key. The model returns grounded answers with source URLs.

```typescript
const response = await ai.models.generateContent({
  model: GEMINI_MEDIUM,
  contents: [createPartFromText(prompt)],
  config: {
    tools: [{ googleSearch: {} }],
  },
});
```

### Prompts

**Book discovery:**
```
Find the fandom wiki page for this comic book series: "{query}"

Return a JSON object with:
- title: full official title of the comic series
- wikiUrl: URL of the fandom wiki page for the series (not a specific issue)
- wikiHost: hostname (e.g., "powerrangers.fandom.com")
- publisher: publisher name
- franchises: array of franchise names involved
- hasParts: boolean — true if the series is divided into named parts/volumes (e.g., "Part I", "Part II")
- parts: if hasParts is true, array of { name, number, issueCount, wikiUrl } for each part. Otherwise null.
- totalIssues: total number of issues across all parts (or in the series if no parts)
- wikiTitleTemplate: the URL path pattern for individual issues, with {number} as placeholder

Return JSON only, no markdown.
```

**Issue source lookup:**
```
Find a website where I can read "{bookTitle}" Issue {number} online.
Return a JSON object with:
- url: the direct URL to read the issue
- siteName: name of the website
- confidence: "high" | "medium" | "low"

Return JSON only, no markdown.
```

---

## Wiki API (structured follow-up)

Once we have the wiki host, the MediaWiki API provides structured data without Gemini:

**List all issues in a series** (category members):
```
https://{wikiHost}/api.php?action=parse&page={seriesPage}&prop=links&format=json
```

This gives us all issue page links, letting us auto-populate `wikiUrls` for the entire series in one call.

**Issue page content** (already implemented in `fetch-wiki-context.ts`):
- Summary text
- Character appearances with qualifiers

---

## UI Design

### Add Next Issue (`/admin/add-issue?book={id}`)

```
┌──────────────────────────────────────────────────────┐
│  Add Issue — TMNT x MMPR III                          │
│                                                        │
│  Next issue: #4 of 5                                   │
│                                                        │
│  Wiki URL                                              │
│  ┌────────────────────────────────────────────────┐   │
│  │ https://powerrangers.fandom.com/.../Issue_4    │   │
│  └────────────────────────────────────────────────┘   │
│  [auto-detected from wiki]              [Edit]         │
│                                                        │
│  Reading Source                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │ https://readcomicsonline.ru/comic/...          │   │
│  └────────────────────────────────────────────────┘   │
│  [found by Gemini]  confidence: high    [Edit]         │
│                                                        │
│  ┌──────────┐  ┌──────────────────────────────┐      │
│  │ Download │  │ Copy terminal command         │      │
│  │ Pages    │  │ pnpm scrape-pages -- --url... │      │
│  └──────────┘  └──────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
```

### Add New Book (`/admin/add-book`)

```
┌──────────────────────────────────────────────────────┐
│  Add New Book                                          │
│                                                        │
│  What comic are you looking for?                       │
│  ┌────────────────────────────────────────────────┐   │
│  │ TMNT He-Man crossover comic                    │   │
│  └────────────────────────────────────────────────┘   │
│  [Search]                                              │
│                                                        │
│  ── Result ──────────────────────────────────────      │
│                                                        │
│  Masters of the Universe / TMNT                        │
│  Publisher: DC Comics / IDW Publishing                  │
│  Issues: 6                                             │
│  Franchises: He-Man, TMNT                              │
│  Wiki: https://he-man.fandom.com/wiki/...              │
│                                                        │
│  Book ID: motu-tmnt                                    │
│  ┌────────────────────────────────────────────────┐   │
│  │ motu-tmnt                                      │   │
│  └────────────────────────────────────────────────┘   │
│                                                        │
│  [Confirm & Create Book]   [Search Again]              │
└──────────────────────────────────────────────────────┘
```

After confirm, redirects to `/admin/add-issue?book=motu-tmnt` for issue 1.

---

## Server Actions

| Action | Purpose |
|--------|---------|
| `searchForBook(query)` | Gemini + Google Search grounding to find wiki page |
| `createBook(config)` | Create book in DB + write `book-config.json` |
| `lookupNextIssue(bookId)` | Query DB for next issue number, construct wiki URL |
| `findReadingSource(bookTitle, issueNumber)` | Gemini + Google Search to find reading URL |
| `startScrape(bookId, issueId, url)` | Trigger scrape-pages server-side (optional) |

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/app/admin/add-book/page.tsx` | New page — book search + create flow |
| `src/app/admin/add-book/actions.ts` | Server actions for book discovery |
| `src/app/admin/add-issue/page.tsx` | New page — issue lookup + download flow |
| `src/app/admin/add-issue/actions.ts` | Server actions for issue lookup |
| `src/app/admin/page.tsx` | Add "Add Book" and "Add Issue" buttons to dashboard |
| `supabase/migrations/xxx_add_book_wiki_fields.sql` | Add wiki_host, wiki_title_template, total_issues, publisher, franchises to books |
| `supabase/migrations/xxx_add_issue_urls.sql` | Add source_url, wiki_url to issues |

---

## Build Order

1. **Book Parts migration** — `book_parts` table + new columns on `books` and `issues` (see [book-parts.md](book-parts.md))
2. **Server actions** — `searchForBook`, `lookupNextIssue`, `findReadingSource`, `createBook`
3. **Add Issue flow** — `/admin/add-issue` — simpler, higher value (used every time you add content)
4. **Add Book flow** — `/admin/add-book` — less frequent, builds on Add Issue
5. **Dashboard integration** — "Add Book" and "Add Issue" buttons on `/admin`
6. **(Stretch) Server-side scraping** — trigger scrape-pages from the browser instead of terminal

---

## Verification

```bash
# Flow 1: Add next issue to existing book
# 1. Navigate to /admin/add-issue?book=tmnt-mmpr-iii
# 2. Should auto-suggest issue 4
# 3. Wiki URL auto-populated from template
# 4. Gemini finds reading source
# 5. User confirms, copies command or triggers download

# Flow 2: Add new book
# 1. Navigate to /admin/add-book
# 2. Type "batman tmnt adventures"
# 3. Gemini returns wiki page, title, issue count
# 4. User confirms, book created in DB
# 5. Redirected to add-issue for issue 1

pnpm typecheck
```

---

## Open Questions

1. **Server-side scraping** — Running Stagehand from a server action would eliminate the terminal step entirely. But Stagehand needs Browserbase credentials and takes 1-3 minutes per issue. Worth it as a stretch goal but not required for v1.

2. **Series hierarchy** — The `series` table exists but isn't widely used. For now, books are the primary unit. Series grouping ("all TMNT crossovers") can be added later without blocking this feature.

3. **Source URL persistence** — Saving the reading source URL lets us re-scrape if pages are bad. But these URLs are ephemeral (sites go down). Store for convenience, don't depend on them.
