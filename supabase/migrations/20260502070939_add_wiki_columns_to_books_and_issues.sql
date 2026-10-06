-- Production's migration history holds this version, and until #472 no
-- file did. The statements below are the ones the history row recorded.

-- Add wiki configuration to books
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS wiki_host text,
  ADD COLUMN IF NOT EXISTS wiki_title_template text;

COMMENT ON COLUMN books.wiki_host IS 'Fandom wiki hostname, e.g. powerrangers.fandom.com';
COMMENT ON COLUMN books.wiki_title_template IS 'MediaWiki page title template with {number} placeholder, e.g. MMPR/TMNT_III_Issue_{number}';

-- Add wiki content to issues
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS wiki_summary text,
  ADD COLUMN IF NOT EXISTS wiki_appearances jsonb;

COMMENT ON COLUMN issues.wiki_summary IS 'Issue summary text extracted from fandom wiki';
COMMENT ON COLUMN issues.wiki_appearances IS 'Character appearances list extracted from wiki [{name, links, aliases}]';
