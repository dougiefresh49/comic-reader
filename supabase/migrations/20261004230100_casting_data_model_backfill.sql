-- Casting data model P1, backfill (#414; spec docs/casting-data-model.html,
-- section Backfill and its three literal lists).
--
-- Fills the tables and columns the schema migration added. It removes
-- nothing: no row is deleted, no bubbles.speaker is rewritten, and
-- character_id is filled only where it is null.
--
-- Three sections, in this order: Cast, Voices, Identity. The lead re-runs a
-- single section at its last-run point (Cast right before P2 deploys, Voices
-- before P3, Identity before P4), so each section runs on its own once the
-- schema file and the sections before it have run once. To run a section on
-- its own, run the Helpers block first: its functions are session-temporary.
-- Running the whole file twice leaves the same rows as running it once.
--
-- Every statement runs inside a transaction.

-- ===========================================================================
-- Helpers (session-temporary; nothing is left behind)
-- ===========================================================================

-- The character id rule, a copy of slugify() in src/lib/character-id.ts:
-- "April O'Neil" -> "april-oneil". Work ids use it too: slug(title)-year.
create or replace function pg_temp.slug(t text) returns text
language sql immutable as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(t)), '[^a-z0-9\s-]', '', 'g'),
      '\s+', '-', 'g'),
    '-+', '-', 'g')
$$;

-- The aliases.alias_norm rule.
create or replace function pg_temp.norm(t text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(t), '\s+', ' ', 'g'))
$$;

-- Every trailing bracket stripped: "Red Ranger (Jason) (1993)" -> "Red Ranger".
create or replace function pg_temp.strip_brackets(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(t, '(\s*\([^()]*\))+\s*$', ''))
$$;

-- Every character a text name could mean, with its tier: 1 the id, 2 the
-- display name, 3 a book-scoped alias, 4 a global alias (the aliases table
-- or an entry of characters.aliases).
create or replace function pg_temp.candidates(p_name text, p_book text)
returns table (cand_tier integer, cand_id text)
language sql stable as $$
  select 1, c.id
  from public.characters c
  where c.id = pg_temp.slug(p_name)
  union all
  select 2, c.id
  from public.characters c
  where pg_temp.norm(c.display_name) = pg_temp.norm(p_name)
  union all
  select 3, a.character_id
  from public.aliases a
  where a.scope = 'book'
    and a.scope_id = p_book
    and a.alias_norm = pg_temp.norm(p_name)
    and a.character_id is not null
  union all
  select 4, a.character_id
  from public.aliases a
  where a.scope = 'global'
    and a.alias_norm = pg_temp.norm(p_name)
    and a.character_id is not null
  union all
  select 4, c.id
  from public.characters c, unnest(c.aliases) as e (alias)
  where pg_temp.norm(e.alias) = pg_temp.norm(p_name)
$$;

-- A text name to a character id. The first tier with any candidate decides;
-- two different characters in that tier is ambiguous and gives null.
create or replace function pg_temp.resolve_exact(p_name text, p_book text) returns text
language sql stable as $$
  with c as (select * from pg_temp.candidates(p_name, p_book))
  select case when count(distinct cand_id) = 1 then min(cand_id) end
  from c
  where cand_tier = (select min(cand_tier) from c)
$$;

-- Owner call 2026-10-04: a name that does not resolve is tried again with
-- every trailing bracket stripped. "Zack Taylor (Omega Black Ranger)" ->
-- "Zack Taylor".
create or replace function pg_temp.resolve_character(p_name text, p_book text) returns text
language sql stable as $$
  select coalesce(
    pg_temp.resolve_exact(p_name, p_book),
    pg_temp.resolve_exact(pg_temp.strip_brackets(p_name), p_book)
  )
$$;

-- ===========================================================================
-- Cast: castlist.character_id, castlist.no_audio.
-- Also creates the characters of literal list 1, which Voices and Identity
-- rely on. Last run: right before P2 deploys.
-- ===========================================================================

-- Literal list 1, characters to create (owner-confirmed 2026-10-04, item E1).
-- The id is the slug of the name. The franchise goes in the old text column,
-- which Identity turns into franchise_id: Sonic and DC become the sonic and
-- dc franchise rows. Kept in the text column, the deployed speaker and face
-- filters (characters in the book's franchises, or with none) see April
-- O'Neil, Goldar, Armored Villain and Rock Soldier in tmnt-mmpr-iii and none
-- of the Sonic or DC rows.
insert into characters (id, display_name, franchise)
select pg_temp.slug(v.name), v.name, v.franchise
from (
  values
    ('Amy Rose', 'Sonic'),
    ('Big', 'Sonic'),
    ('Blaze', 'Sonic'),
    ('Charmy', 'Sonic'),
    ('Dr. Eggman', 'Sonic'),
    ('Espio', 'Sonic'),
    ('Infinite', 'Sonic'),
    ('Jet', 'Sonic'),
    ('Knuckles', 'Sonic'),
    ('Rouge', 'Sonic'),
    ('Shadow', 'Sonic'),
    ('Silver', 'Sonic'),
    ('Sonic', 'Sonic'),
    ('Storm', 'Sonic'),
    ('Tails', 'Sonic'),
    ('Tangle', 'Sonic'),
    ('Vector', 'Sonic'),
    ('Alfred', 'DC'),
    ('Bane', 'DC'),
    ('Batman', 'DC'),
    ('Cyborg', 'DC'),
    ('Darkseid', 'DC'),
    ('Flash', 'DC'),
    ('Star Sapphire', 'DC'),
    ('Supergirl', 'DC'),
    ('Superman', 'DC'),
    ('Wonder Woman', 'DC'),
    ('April O''Neil', 'TMNT'),
    ('Goldar', 'Power Rangers'),
    ('Armored Villain', null),
    ('Rock Soldier', null)
) as v (name, franchise)
on conflict (id) do nothing;

-- No other character is created here. A castlist name that still resolves
-- to nothing keeps a null character_id and fails the lead's gate, and a
-- person adds the row. Narrower than the spec (decision row 288), because a
-- row made from a name's slug would outrank every alias and display name in
-- every book. Today the only two unresolved names are in the list above.

-- Only where character_id is null, so a link seedCast already wrote is kept.
-- Nothing here stops two rows of one issue resolving to the same character:
-- the unique index on (book_id, issue_id, character_id) waits for P2.
update castlist k
set character_id = r.character_id
from (
  select book_id, issue_id, character,
         pg_temp.resolve_character(character, book_id) as character_id
  from castlist
  where character_id is null
) r
where k.book_id = r.book_id
  and k.issue_id = r.issue_id
  and k.character = r.character
  and r.character_id is not null;

-- Mirrors the __SKIPPED__ marker (SKIPPED_VOICE in src/lib/voice-settings.ts)
-- until P2 makes no_audio the only home.
update castlist
set no_audio = coalesce(voice_id = '__SKIPPED__', false)
where no_audio <> coalesce(voice_id = '__SKIPPED__', false);

-- ===========================================================================
-- Voices: works, appearances, voices.character_id, voices.starting_pick,
-- voices.appearance_id, and the content of old appearance rows.
-- Last run: right before P3 deploys.
-- ===========================================================================

-- Every ElevenLabs id a voice holds or held. Archive nulls
-- current_elevenlabs_id and logs the old id in voice_archives, and restore
-- writes a new one; neither touches character_appearances.
create or replace temp view voice_elevenlabs_ids as
select v.id as voice_id, v.current_elevenlabs_id as elevenlabs_id
from voices v
where v.current_elevenlabs_id is not null
union
select va.voice_id, va.former_elevenlabs_id
from voice_archives va;

-- Each ElevenLabs id on an old appearance row must already be on a voices
-- row, now or before an archive (an empty string is not an id).
do $$
declare
  missing text;
begin
  select string_agg(ca.id, ', ' order by ca.id)
  into missing
  from character_appearances ca
  where nullif(btrim(ca.voice_id), '') is not null
    and not exists (
      select 1 from voice_elevenlabs_ids e where e.elevenlabs_id = ca.voice_id
    );
  if missing is not null then
    raise exception 'character_appearances rows hold an ElevenLabs id no voices row has: %', missing;
  end if;
end
$$;

-- Literal list 2, duplicate works to merge (owner-confirmed 2026-10-04).
create or replace temp view work_merges as
select *
from (
  values
    ('TMNT: Mutants in Manhattan', 2016,
      'Teenage Mutant Ninja Turtles: Mutants in Manhattan', 2016, 'video_game'),
    ('TMNT: Shredder''s Revenge', 2022,
      'Teenage Mutant Ninja Turtles: Shredder''s Revenge', 2022, 'video_game'),
    ('Power Rangers: Battle for the Grid', 2021,
      'Power Rangers: Battle for the Grid', 2019, 'video_game'),
    ('Power Rangers Samurai', 2012,
      'Power Rangers Samurai', 2011, 'live_action')
) as m (old_title, old_year, title, year, medium);

-- Literal list 3, variant in a voice name to work (owner-confirmed 2026-10-04).
create or replace temp view variant_works as
select v.variant, v.title, v.year, v.medium,
       pg_temp.slug(v.title) || '-' || v.year as work_id
from (
  values
    ('1990', 'Teenage Mutant Ninja Turtles', 1990, 'movie'),
    ('2012', 'Teenage Mutant Ninja Turtles', 2012, 'animated_series'),
    ('1993', 'Mighty Morphin Power Rangers', 1993, 'live_action'),
    ('Forces', 'Sonic Forces', 2017, 'video_game'),
    ('Prime', 'Sonic Prime', 2022, 'animated_series'),
    ('Shadow Generations', 'Sonic X Shadow Generations', 2024, 'video_game'),
    ('CrossWorlds', 'Sonic Racing: CrossWorlds', 2025, 'video_game'),
    ('JL Doom', 'Justice League: Doom', 2012, 'movie'),
    ('JL War', 'Justice League: War', 2014, 'movie'),
    ('SB Apocalypse', 'Superman/Batman: Apocalypse', 2010, 'movie'),
    ('TDKR', 'The Dark Knight Rises', 2012, 'movie'),
    ('Boom', 'Sonic Boom', 2014, 'animated_series'),
    ('Chaotix', 'Sonic the Hedgehog Presents: The Chaotix Casefiles', 2026, 'podcast')
) as v (variant, title, year, medium);

-- Each old non-design appearance row with the work it lands on. A title that
-- carries its own year, "The Lord of the Rings: The Fellowship of the Ring
-- (2001)", loses the bracket so the id does not repeat the year.
create or replace temp view old_appearance_works as
select o.*, pg_temp.slug(o.title) || '-' || o.year as work_id
from (
  select ca.id as old_id,
         ca.character_id,
         ca.voice_actor,
         ca.youtube_search_terms,
         ca.notes,
         ca.voice_id,
         ca.voice_status,
         coalesce(
           m.title,
           btrim(regexp_replace(ca.media_title, '\s*\(' || ca.year || '\)\s*$', ''))
         ) as title,
         coalesce(m.year, ca.year) as year,
         coalesce(m.medium, ca.media_type) as medium
  from character_appearances ca
  left join work_merges m
    on m.old_title = ca.media_title
   and m.old_year = ca.year
  where ca.media_type is distinct from 'voice_design'
) o;

-- One work per distinct title, year and medium, after the merges, plus the
-- variant works. franchise_id is filled in Identity, which creates the
-- franchises rows.
insert into works (id, title, year, medium)
select distinct on (work_id) work_id, title, year, medium
from old_appearance_works
order by work_id, old_id
on conflict (id) do nothing;

insert into works (id, title, year, medium)
select work_id, title, year, medium
from variant_works
on conflict (id) do nothing;

-- One appearance per old non-design row. Where a merge puts one character in
-- one work twice, the row with a voice actor is kept.
insert into appearances (character_id, work_id, voice_actor, search_terms, notes)
select distinct on (character_id, work_id)
       character_id, work_id, voice_actor, youtube_search_terms, notes
from old_appearance_works
order by character_id, work_id, (voice_actor is null), old_id
on conflict (character_id, work_id) do nothing;

-- The character is the voice name with every trailing bracket stripped.
update voices v
set character_id = r.character_id
from (
  select id,
         pg_temp.resolve_character(pg_temp.strip_brackets(display_name), null) as character_id
  from voices
  where character_id is null
) r
where v.id = r.id
  and r.character_id is not null;

-- Mirrors lab_default until P3 makes starting_pick the only home.
update voices
set starting_pick = lab_default
where starting_pick is distinct from lab_default;

-- A voice whose last bracket is a listed variant is a clone from that work;
-- its appearance is created when the old table had none.
create or replace temp view voice_variant_works as
select v.id as voice_id, v.character_id, w.work_id
from voices v
join variant_works w
  on w.variant = substring(v.display_name from '\(([^()]*)\)\s*$')
where v.character_id is not null;

insert into appearances (character_id, work_id)
select distinct character_id, work_id
from voice_variant_works
on conflict (character_id, work_id) do nothing;

-- voices.appearance_id, only where null and only to an appearance no voice
-- holds yet. A voice reaches an appearance through its name's variant, or
-- through an old non-design row holding its ElevenLabs id (current or
-- archived) for the same character (the clones in slots today). When two voices reach one
-- appearance, it goes to the active one, else the starting pick, else the
-- newest; the others keep a null appearance_id.
update voices v
set appearance_id = w.appearance_id
from (
  select distinct on (o.appearance_id) o.voice_id, o.appearance_id
  from (
    select distinct on (c.voice_id) c.voice_id, c.appearance_id
    from (
      select vv.voice_id, a.id as appearance_id, 1 as source
      from voice_variant_works vv
      join appearances a
        on a.character_id = vv.character_id
       and a.work_id = vv.work_id
      union all
      select vo.id, a.id, 2
      from voices vo
      join voice_elevenlabs_ids e on e.voice_id = vo.id
      join old_appearance_works ow
        on ow.voice_id = e.elevenlabs_id
       and ow.character_id = vo.character_id
      join appearances a
        on a.character_id = ow.character_id
       and a.work_id = ow.work_id
    ) c
    order by c.voice_id, c.source, c.appearance_id
  ) o
  join voices cand on cand.id = o.voice_id
  where cand.appearance_id is null
    and not exists (
      select 1 from voices t where t.appearance_id = o.appearance_id
    )
  order by o.appearance_id,
           (cand.status = 'active') desc,
           (cand.starting_pick is true) desc,
           cand.created_at desc,
           cand.id
) w
where v.id = w.voice_id;

-- Old appearance voice content. The voice's own description wins, since it
-- is what restore sends to ElevenLabs; the old one fills only a blank.
update voices v
set description = ca.voice_description
from voice_elevenlabs_ids e
join character_appearances ca on ca.voice_id = e.elevenlabs_id
where e.voice_id = v.id
  and v.description is null
  and nullif(btrim(ca.voice_description), '') is not null;

-- An old row waiting for clips becomes a needs_clip voice on its appearance,
-- unless a voice already holds that appearance.
insert into voices (display_name, status, character_id, appearance_id)
select coalesce(c.display_name, c.id) || ' (' || o.year || ')',
       'needs_clip',
       o.character_id,
       a.id
from old_appearance_works o
join appearances a
  on a.character_id = o.character_id
 and a.work_id = o.work_id
join characters c on c.id = o.character_id
where o.voice_status = 'needs_clips'
  and not exists (select 1 from voices t where t.appearance_id = a.id);

-- ===========================================================================
-- Identity: aliases, franchises, book_franchises, characters.franchise_id,
-- works.franchise_id, characters.form_of, bubbles.character_id.
-- Last run: right before P4 deploys.
-- ===========================================================================

-- Every characters.aliases entry the table lacks, scope global, narrowed by
-- two skips the spec does not name. An entry that is the character's own
-- display name is left out: the resolver matches the display name already.
-- An entry that is another character's id or display name is left out too:
-- the deployed buildAliasMap and resolveAlias (audio-plan.ts) check the
-- aliases table before names, so the row would take that character's
-- speakers. canonical is filled for the deployed readers until P4.
insert into aliases (alias, canonical, character_id, scope)
select distinct on (pg_temp.norm(e.alias))
       btrim(e.alias), coalesce(c.display_name, c.id), c.id, 'global'
from characters c, unnest(c.aliases) as e (alias)
where btrim(e.alias) <> ''
  and pg_temp.norm(e.alias) is distinct from pg_temp.norm(c.display_name)
  and not exists (
    select 1
    from characters o
    where o.id <> c.id
      and (
        o.id = pg_temp.slug(e.alias)
        or pg_temp.norm(o.display_name) = pg_temp.norm(e.alias)
      )
  )
  and not exists (
    select 1
    from aliases a
    where a.scope = 'global'
      and a.alias_norm = pg_temp.norm(e.alias)
  )
order by pg_temp.norm(e.alias), c.id
on conflict do nothing;

-- One franchises row per distinct franchise text (characters and books).
-- "TMNT MMPR" -> tmnt-mmpr; the Sonic and DC characters from Cast give sonic
-- and dc.
insert into franchises (id, name)
select distinct on (pg_temp.slug(f.name)) pg_temp.slug(f.name), btrim(f.name)
from (
  select franchise as name from characters
  union
  select unnest(franchises) from books
) f
where f.name is not null
  and pg_temp.slug(f.name) <> ''
order by pg_temp.slug(f.name), f.name
on conflict (id) do nothing;

-- One row per books.franchises entry, position = its index from 0. Mirrors
-- the array until P4 makes this table the only home.
insert into book_franchises (book_id, franchise_id, position)
select distinct on (b.id, pg_temp.slug(f.name))
       b.id, pg_temp.slug(f.name), (f.ord - 1)::integer
from books b, unnest(b.franchises) with ordinality as f (name, ord)
where pg_temp.slug(f.name) <> ''
order by b.id, pg_temp.slug(f.name), f.ord
on conflict (book_id, franchise_id) do update
  set position = excluded.position
  where book_franchises.position is distinct from excluded.position;

update characters
set franchise_id = pg_temp.slug(franchise)
where franchise_id is null
  and pg_temp.slug(franchise) <> '';

-- A work's franchise is the one most of its appearing characters share; ties
-- go to the lower id. A work whose characters have none, such as the
-- narrator's source film, stays null.
update works w
set franchise_id = p.franchise_id
from (
  select distinct on (a.work_id) a.work_id, c.franchise_id
  from appearances a
  join characters c on c.id = a.character_id
  where c.franchise_id is not null
  group by a.work_id, c.franchise_id
  order by a.work_id, count(*) desc, c.franchise_id
) p
where w.id = p.work_id
  and w.franchise_id is null;

update characters
set form_of = voice_of
where form_of is null
  and voice_of is not null;

-- Only where character_id is null. bubbles.speaker is not touched; a speaker
-- that still does not resolve, or is ambiguous, stays null and is listed for
-- review.
update bubbles b
set character_id = r.character_id
from (
  select id, pg_temp.resolve_character(speaker, book_id) as character_id
  from bubbles
  where character_id is null
    and speaker is not null
) r
where b.id = r.id
  and r.character_id is not null;
