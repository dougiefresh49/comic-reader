-- voices.lab_default (#261).
--
-- `pnpm voice-lab-import` sets it on each candidate row from the `default`
-- field of the book's voice-lab cast.json: true on the owner's starting
-- pick for that character, false on its other variants. Null on rows that
-- did not come from a cast sheet, which is every live voice today. The flag
-- is a starting pick, not a lock; switching variant is a casting action
-- (#108). Purely additive: one nullable column, nothing dropped, renamed
-- or backfilled here.

alter table voices
  add column if not exists lab_default boolean;
