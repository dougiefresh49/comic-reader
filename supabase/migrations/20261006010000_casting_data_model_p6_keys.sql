-- Casting data model P6, migration A: keys (#470; spec docs/casting-data-model.html,
-- section P6 Drop; rules R3 and R6).
--
-- Drops nothing: no table, column or row is removed. The castlist primary key
-- moves from the text column to character_id, and castlist.character becomes
-- nullable so the code that stops writing it can deploy. Migration B
-- (20261006010100_casting_data_model_p6_drop.sql) drops the old columns and
-- tables later, after the deploy and owner sign-off O4; it never runs in the
-- same transaction as this file. The P2 unique index
-- castlist_book_id_issue_id_character_id_key stays until migration B.
--
-- Every statement runs inside the migration's transaction. First six checks,
-- each raising an exception named after it, so one failure rolls the whole
-- file back and changes nothing:
--   1. castlist_character_id_not_null: no castlist row with a null character_id.
--   2. castlist_key_unique: no two castlist rows share (book_id, issue_id, character_id).
--   3. castlist_skipped_is_no_audio: every castlist row whose voice_id is
--      '__SKIPPED__' has no_audio true.
--   4. comic_voices_have_character: no voices row with 'comic' in consumers
--      and a null character_id.
--   5. aliases_character_id_not_null: no aliases row with a null character_id.
--   6. one_stored_design_per_character: no character_id with two voices rows
--      where appearance_id is null and status = 'needs_clip'.
-- Then, in this order: aliases.character_id set not null; castlist.character_id
-- set not null, castlist_pkey re-keyed on (book_id, issue_id, character_id),
-- castlist.character made nullable; the partial unique index
-- voices_stored_design_per_character_key (owner answer O1 = A on #458).

do $$
declare
  n bigint;
begin
  select count(*) into n from castlist where character_id is null;
  if n > 0 then
    raise exception 'p6 check castlist_character_id_not_null failed: % castlist rows have a null character_id', n;
  end if;

  select count(*) into n from (
    select 1 from castlist
    group by book_id, issue_id, character_id
    having count(*) > 1
  ) d;
  if n > 0 then
    raise exception 'p6 check castlist_key_unique failed: % (book_id, issue_id, character_id) keys hold more than one castlist row', n;
  end if;

  select count(*) into n from castlist
  where voice_id = '__SKIPPED__' and no_audio is not true;
  if n > 0 then
    raise exception 'p6 check castlist_skipped_is_no_audio failed: % castlist rows hold __SKIPPED__ without no_audio', n;
  end if;

  select count(*) into n from voices
  where 'comic' = any (consumers) and character_id is null;
  if n > 0 then
    raise exception 'p6 check comic_voices_have_character failed: % comic voices rows have a null character_id', n;
  end if;

  select count(*) into n from aliases where character_id is null;
  if n > 0 then
    raise exception 'p6 check aliases_character_id_not_null failed: % aliases rows have a null character_id', n;
  end if;

  select count(*) into n from (
    select 1 from voices
    where appearance_id is null and status = 'needs_clip'
      and character_id is not null
    group by character_id
    having count(*) > 1
  ) d;
  if n > 0 then
    raise exception 'p6 check one_stored_design_per_character failed: % characters have more than one stored design (needs_clip, no appearance)', n;
  end if;
end
$$;

-- R6: every alias row names a character.
alter table aliases alter column character_id set not null;

-- R3: the castlist key is (book_id, issue_id, character_id).
alter table castlist alter column character_id set not null;
alter table castlist
  drop constraint castlist_pkey,
  add constraint castlist_pkey primary key (book_id, issue_id, character_id);
alter table castlist alter column "character" drop not null;

-- At most one stored design (a needs_clip row with no appearance) per
-- character. Two description saves that race now fail on this index instead
-- of leaving two rows (decision log row 300).
create unique index voices_stored_design_per_character_key
  on voices (character_id)
  where appearance_id is null and status = 'needs_clip';
