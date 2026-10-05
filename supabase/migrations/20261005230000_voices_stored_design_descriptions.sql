-- Casting data model P3 (#458; spec docs/casting-data-model.html, section
-- P3 Voices and appearances, and the issue's first decision).
--
-- A voice description written before its voice exists lives on a voices
-- row: status needs_clip, appearance_id null, character_id set, and the text
-- in description and design_prompt. The description step upserts that row
-- and designing the voice makes the same row active. This carries over the
-- old character_appearances design rows that hold a description and whose
-- character has no voices row at all. On 2026-10-05 those are
-- crowd-voice-design and off-panel-voice-design.
--
-- Rows only, no schema. Safe to run twice: the first run gives each of
-- those characters a voices row, so a second run selects nothing.
--
-- The character is the design row's id without "-voice-design", the key the
-- code looked a description up by; the row's own character_id can differ
-- (armored-villain-voice-design carries soldier). A prefix with no
-- characters row is skipped.

insert into voices
  (display_name, status, character_id, appearance_id, description, design_prompt)
select distinct on (c.id)
       coalesce(c.display_name, c.id),
       'needs_clip',
       c.id,
       null,
       ca.voice_description,
       ca.voice_description
from character_appearances ca
join characters c
  on c.id = regexp_replace(ca.id, '-voice-design$', '')
where ca.id like '%-voice-design'
  and nullif(btrim(ca.voice_description), '') is not null
  and not exists (select 1 from voices v where v.character_id = c.id)
order by c.id, ca.id;
