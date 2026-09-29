-- Canonical character ids (#95, step 1 of 5 under #90).
--
-- Additive only. Every new column is nullable so existing writers keep
-- working; NOT NULL on characters.display_name and aliases.character_id
-- waits for #118. castlist, voices and panels ids are filled in #100.
-- Every data step is a no-op on empty tables (Supabase preview branches).
--
-- Slug rule (decision 2): lowercase, strip everything but [a-z0-9] and
-- whitespace, whitespace runs to '-'.
--
-- aliases.canonical is left as is: readers still resolve through it until
-- #100 moves them to character_id, so the green ranger shredder repoint
-- touches character_id only.

-- characters

alter table characters
  add column if not exists display_name text;

alter table characters
  add column if not exists voice_of text references characters (id);

alter table characters
  add column if not exists voice_mode text
    check (voice_mode in ('morphed', 'super'));

-- Dimension X Rangers get their own rows (decisions row 27). Inserted only
-- when an alias needs them, so an empty database stays empty.
insert into characters (id, franchise)
select v.id, 'TMNT MMPR'
from (values ('green-dimension-x-ranger'), ('yellow-dimension-x-ranger')) as v (id)
where exists (
  select 1
  from aliases a
  where regexp_replace(btrim(regexp_replace(lower(a.canonical), '[^a-z0-9\s]', '', 'g')), '\s+', '-', 'g') = v.id
)
on conflict (id) do nothing;

-- Decision 1: the castlist spelling whose slug is the id (keeps "Dr. Boyd",
-- "Alpha 5"), else the id title-cased.
update characters c
set display_name = coalesce(
  (
    select min(k.character)
    from castlist k
    where regexp_replace(btrim(regexp_replace(lower(k.character), '[^a-z0-9\s]', '', 'g')), '\s+', '-', 'g') = c.id
  ),
  initcap(replace(c.id, '-', ' '))
)
where c.display_name is null;

-- aliases

alter table aliases
  add column if not exists alias_norm text
    generated always as (lower(regexp_replace(btrim(alias), '\s+', ' ', 'g'))) stored;

alter table aliases
  add column if not exists character_id text references characters (id);

-- Decision 2: keep the lowest id per (alias_norm, scope, scope_id).
delete from aliases a
using aliases b
where a.alias_norm = b.alias_norm
  and a.scope = b.scope
  and a.scope_id is not distinct from b.scope_id
  and b.id < a.id;

-- A canonical with no matching characters row fails the foreign key and
-- aborts the migration rather than leaving a null.
update aliases
set character_id = case
  when alias_norm = 'green ranger shredder' then 'green-ranger-shredder'
  else regexp_replace(btrim(regexp_replace(lower(canonical), '[^a-z0-9\s]', '', 'g')), '\s+', '-', 'g')
end
where character_id is null;

-- Decision 4 (decisions row 31).
update aliases
set scope = 'book', scope_id = 'tmnt-mmpr-iii'
where alias_norm = 'scientist'
  and scope = 'global';

create unique index if not exists aliases_alias_norm_scope_scope_id_key
  on aliases (alias_norm, scope, scope_id) nulls not distinct;

-- castlist, voices, panels (filled in #100)

alter table castlist
  add column if not exists character_id text references characters (id);

alter table voices
  add column if not exists character_id text references characters (id);

alter table panels
  add column if not exists primary_character_id text references characters (id);
