-- Casting data model P6, migration B: drop (#470; spec docs/casting-data-model.html,
-- sections Tables and P6 Drop; rules R1, R2, R4, R6 and R7).
--
-- Destructive. Applied by the lead after migration A
-- (20261006010000_casting_data_model_p6_keys.sql), the merge, the deploy, the
-- pre-B name gate, the copy of every affected table under
-- ~/comic-reader-backups/p6-before-drop-<date>/, and owner sign-off O4. Never
-- in the same transaction as migration A.
--
-- Order: the guard below, the ten column drops, the leftover aliases key, the
-- P2 castlist index (the primary key from migration A covers the same three
-- columns), then the five tables, series last because books.series_id and
-- voices.series_id referenced it. Every statement uses if exists, so the file
-- is safe to run twice. Nothing uses cascade.
--
-- Dependent objects that go with their owners, without cascade:
--   characters_voice_of_fkey  with characters.voice_of
--   books_series_id_fkey      with books.series_id
--   voices_series_id_idx      with voices.series_id
--   the "public read" row-level policies on series and character_appearances
--   (and any policy, index or trigger on the other three tables) with their
--   tables.

-- Guard: castlist.character is still in castlist_pkey until migration A runs,
-- and dropping the column would take the primary key with it. Refuse unless
-- the primary key is exactly (book_id, issue_id, character_id); a looser
-- test (any key that mentions character_id) would let a key that also holds
-- "character" through, and the column drop would then remove it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.castlist'::regclass and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (book_id, issue_id, character_id)'
  ) then
    raise exception 'p6 drop refused: castlist_pkey is not exactly (book_id, issue_id, character_id); apply migration A (20261006010000_casting_data_model_p6_keys.sql) first';
  end if;
end
$$;

-- The ten columns.
alter table castlist drop column if exists "character";
alter table castlist drop column if exists voice_id;
alter table characters drop column if exists franchise;
alter table characters drop column if exists aliases;
alter table characters drop column if exists voice_of;
alter table aliases drop column if exists canonical;
alter table voices drop column if exists series_id;
alter table voices drop column if exists lab_default;
alter table books drop column if exists franchises;
alter table books drop column if exists series_id;

-- The leftover key from #118, beside the live aliases_alias_norm_scope_scope_id_key.
-- It is a unique constraint (unique nulls not distinct (alias, scope, scope_id)),
-- not a bare index, so it is dropped as a constraint.
alter table aliases drop constraint if exists aliases_alias_scope_scope_id_key;

-- The P2 unique index; castlist_pkey now holds the same three columns.
drop index if exists castlist_book_id_issue_id_character_id_key;

-- The five tables.
drop table if exists character_appearances;
drop table if exists speaker_reviews;
drop table if exists bubbles_character_id_backup_v1;
drop table if exists panel_character_detections_backup_v1;
drop table if exists series;
