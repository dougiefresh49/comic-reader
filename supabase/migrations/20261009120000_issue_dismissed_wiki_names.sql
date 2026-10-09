-- The characters stop's Needs a name section can dismiss a wiki name (#751).
--
-- A dismissed name is stored per issue as its slug, so a re-fetch of the wiki
-- (which rewrites issues.wiki_appearances) does not bring it back. Restore
-- removes the slug. Dismissing never creates a character, alias or cast row.

alter table public.issues
  add column dismissed_wiki_names text[] not null default '{}';

comment on column public.issues.dismissed_wiki_names is
  'Wiki names the characters stop''s Needs a name section hides for this issue, as slugs; never creates a character, alias or cast row';
