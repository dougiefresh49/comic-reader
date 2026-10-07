-- characters.full_name (#562): the character's full name ("Tangle the Lemur"),
-- which the voice lookup prompts carry beside the display name when it says
-- something more. Null means the character has no full name beyond its
-- display name.
--
-- Additive only: one nullable column, so every existing row reads as having
-- no full name. The table's RLS and grants are unchanged.

alter table characters
  add column if not exists full_name text
  check (full_name is null or btrim(full_name) <> '');
