-- pages.spread_with_next (#723): true on page N means pages N and N+1 are one
-- spread (art drawn across the centre seam), so the flag sits on the left
-- page. The detect-spreads step suggests it and the review editor confirms,
-- adds or removes it. No constraint stops a page from being part of two
-- spreads: a CHECK cannot see the neighbouring row, so the editor's server
-- action and the step enforce that rule.
--
-- Additive only: one column with a default, so every existing row reads as
-- not a spread. The table's RLS and grants are unchanged.

ALTER TABLE pages ADD COLUMN spread_with_next boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.spread_with_next IS
  'Spreads (#723): true means this page and the next one are one spread; set on the left page.';
