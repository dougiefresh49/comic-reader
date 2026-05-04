# Feature: Book Parts (Multi-Part Series Support)

## Status: `pending`
## Prerequisite: None (additive schema change)
## Blocks: Smart Add Flow (for multi-part series like TMNT x MMPR)

---

## Problem

The current data model assumes a flat `books > issues` hierarchy:

```
books
  └── issues (1, 2, 3, ...)
```

This works for standalone mini-series (TMNT x MMPR Part III = 5 issues) but breaks down for:

1. **Multi-part mini-series** — TMNT x Power Rangers has 3 parts, each with 5 issues. Currently each part is a separate "book" (`tmnt-mmpr-i`, `tmnt-mmpr-ii`, `tmnt-mmpr-iii`), which loses the connection between them.

2. **Long-running series** — Sonic IDW has 70+ individual issues. Volumes and collections exist as packaging but aren't meaningful groupings. This works fine as a single book with many issues.

3. **Crossover mini-series** — Sonic x DC is a standalone mini-series, ~6 issues. Works as a single book.

The gap is case 1: we need an optional grouping layer between book and issue for multi-part series.

---

## Solution

Add a `book_parts` table and a nullable `part_id` column on `issues`.

```
books (conceptually = "series", name kept for FK stability)
  └── book_parts (optional sub-grouping: Part I, Part II, etc.)
       └── issues
```

### Examples

| Book ID | Part | Issue | Displayed As |
|---------|------|-------|-------------|
| `sonic-idw` | — | 1-70 | Sonic IDW > Issue 12 |
| `sonic-dc` | — | 1-6 | Sonic x DC > Issue 3 |
| `tmnt-mmpr` | Part I | 1-5 | TMNT x MMPR > Part I > Issue 2 |
| `tmnt-mmpr` | Part II | 1-5 | TMNT x MMPR > Part II > Issue 4 |
| `tmnt-mmpr` | Part III | 1-5 | TMNT x MMPR > Part III > Issue 1 |

For long-running series, `part_id` is null — issues belong directly to the book.
For multi-part series, each issue references its part.

---

## Migration: Existing Data

Current state: `tmnt-mmpr-iii` is a book with issues 1-3.

**Two options for migration:**

### Option A: Leave as-is (recommended for now)
Keep `tmnt-mmpr-iii` as a standalone book. It works fine. When/if you add Part I and Part II, create a new book `tmnt-mmpr` with three parts. The old `tmnt-mmpr-iii` book can coexist or be migrated later.

### Option B: Migrate to unified book
Create book `tmnt-mmpr`, create parts I/II/III, migrate existing issues from `tmnt-mmpr-iii` to `tmnt-mmpr` with `part_id` pointing to Part III. Requires updating `book_id` in issues, panels, bubbles, castlist, etc. — doable but not urgent.

**Recommendation:** Option A. Start fresh with new books using the parts model. Migrate old data later if it matters.

---

## Schema

### New table: `book_parts`

```sql
create table book_parts (
  id text primary key,
  book_id text not null references books (id),
  number integer not null,
  name text not null,
  slug text not null,
  wiki_url text,
  total_issues integer,
  created_at timestamptz default now(),
  unique (book_id, number)
);

create index book_parts_book_id on book_parts (book_id);
```

### New columns on `books`

```sql
alter table books
  add column wiki_host text,
  add column wiki_title_template text,
  add column total_issues integer,
  add column publisher text,
  add column franchises text[];
```

### New columns on `issues`

```sql
alter table issues
  add column part_id text references book_parts (id),
  add column source_url text,
  add column wiki_url text;
```

### Updated columns on `issues` (already partially exist)

`wiki_summary` and `wiki_appearances` may already exist from `fetch-wiki-context.ts` usage. If not in the migration, add:

```sql
alter table issues
  add column if not exists wiki_summary text,
  add column if not exists wiki_appearances jsonb;
```

---

## Impact on Existing Code

### No breaking changes

- `book_id` FK stays the same everywhere
- `part_id` is nullable — all existing issues have `part_id = null`
- Existing queries don't need to join `book_parts`
- Pipeline scripts continue to use `--book` and `--issue` args unchanged

### Display changes (opt-in)

The admin dashboard and reader can optionally show the part grouping:
- Dashboard: group issues by part within a book
- Reader: show "Part III > Issue 2" in breadcrumbs
- Add Issue flow: select which part to add to (or "no part" for flat series)

### Pipeline awareness

The pipeline doesn't need to know about parts. It operates on `(book_id, issue_id)` pairs as before. Parts are a UI/organizational concept, not a processing one.

---

## `book-config.json` Updates

Currently per-book:
```json
{
  "title": "Mighty Morphin Power Rangers / Teenage Mutant Ninja Turtles III",
  "franchises": ["TMNT", "MMPR"],
  "wikiUrls": { "issue-1": "...", "issue-2": "..." }
}
```

With parts, the config can optionally include part info:
```json
{
  "title": "Teenage Mutant Ninja Turtles x Power Rangers",
  "franchises": ["TMNT", "Power Rangers"],
  "parts": {
    "part-1": { "name": "Part I", "wikiUrls": { "issue-1": "...", ... } },
    "part-2": { "name": "Part II", "wikiUrls": { "issue-1": "...", ... } },
    "part-3": { "name": "Part III", "wikiUrls": { "issue-1": "...", ... } }
  }
}
```

For flat series (Sonic), no `parts` key — `wikiUrls` stays at the top level.

---

## Asset Directory Structure

### Current (flat)
```
assets/comics/tmnt-mmpr-iii/
  book-config.json
  issue-1/
  issue-2/
```

### With parts (two options)

**Option A: Part prefix in issue ID** (simpler, no dir nesting)
```
assets/comics/tmnt-mmpr/
  book-config.json
  part-1-issue-1/
  part-1-issue-2/
  part-3-issue-1/
```

**Option B: Nested directories** (cleaner, matches hierarchy)
```
assets/comics/tmnt-mmpr/
  book-config.json
  part-1/
    issue-1/
    issue-2/
  part-3/
    issue-1/
```

**Recommendation:** Option A — the pipeline uses `(book_id, issue_id)` everywhere. Encoding the part in the issue ID (`part-3-issue-1`) avoids changing any directory traversal logic. The `part_id` FK in the DB handles the relationship.

For flat series, issue IDs stay as `issue-1`, `issue-2`, etc.

---

## Build Order

1. **Migration** — `book_parts` table + new columns on `books` and `issues`
2. **Backfill** — Add `wiki_host`, `franchises`, `publisher` to existing `tmnt-mmpr-iii` book row
3. **Admin dashboard** — Show parts grouping in issue list (if `book_parts` exist for that book)
4. **Smart Add Flow** — Part selection when adding issues to multi-part books

---

## Verification

```sql
-- After migration, verify existing data unaffected
select b.id, count(i.id) as issue_count
from books b
left join issues i on i.book_id = b.id
group by b.id;

-- Verify part_id is null for all existing issues
select count(*) from issues where part_id is not null;
-- Should be 0
```

```bash
pnpm typecheck
pnpm ingest -- --book tmnt-mmpr-iii --issue 3 --dry-run
# Should still work unchanged
```
