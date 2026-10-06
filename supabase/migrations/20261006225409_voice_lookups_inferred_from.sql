-- voice_lookups.inferred_from (#552): when the model did not know the work,
-- the lookup describes the voice from the character's other works in the same
-- franchise, and this column names the actor and works it was inferred from,
-- in the model's words. Null means the model answered for the work itself.
--
-- Additive only: one nullable column, so every stored row reads as a direct
-- answer. The table's RLS and grant are unchanged.

alter table voice_lookups
  add column if not exists inferred_from text
  check (inferred_from is null or btrim(inferred_from) <> '');
