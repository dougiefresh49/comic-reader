-- Casting data model P1 (#414; decision log row 289): aliases.canonical goes
-- back to not null.
--
-- The schema migration before this one made it nullable, as the spec's P1
-- list asks. The regenerated types then typed canonical as string | null,
-- and four deployed readers in src/ and scripts/ stopped compiling. P1 edits
-- no code, so the column stays not null until P4, the issue that stops
-- writing it; P4's migration makes it nullable.
--
-- Fails, and changes nothing, if any row holds a null.
alter table aliases
  alter column canonical set not null;
