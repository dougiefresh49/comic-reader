-- Casting data model P2 (#429; spec docs/casting-data-model.html, section
-- P2 Cast and audio; decision log row 286): the unique index P1 left out.
--
-- Every castlist write in src/lib/cast.ts finds its row by character_id, and
-- its upsert conflicts on this index. P1 could not create it while the
-- deployed registerCastVoice upserted on the text column.
--
-- Fails, and changes nothing, if two rows share (book_id, issue_id,
-- character_id). Check first:
--   select book_id, issue_id, character_id, count(*) from castlist
--   group by 1, 2, 3 having count(*) > 1;
-- Rows with a null character_id never conflict with each other.
create unique index castlist_book_id_issue_id_character_id_key
  on castlist (book_id, issue_id, character_id);
