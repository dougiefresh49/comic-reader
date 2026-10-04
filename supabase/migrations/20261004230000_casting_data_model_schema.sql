-- Casting data model P1, schema (#414; spec docs/casting-data-model.html,
-- sections Tables and P1 Add; decision log rows 284 to 288).
--
-- Additive only. Every statement adds a table, a column, an index, a
-- grant or a constraint, or loosens one (aliases.canonical becomes nullable, the
-- voices.status check gains a value). Nothing is removed or renamed, so the
-- deployed code keeps working against the result. The backfill is the next
-- migration file.
--
-- New tables get RLS with a public read policy, like characters and castlist.

-- franchises

create table if not exists franchises (
  id text primary key,
  name text not null
);

alter table franchises enable row level security;
create policy "public read" on franchises for select using (true);

-- book_franchises: replaces books.franchises text[]. The lowest position is
-- the default franchise for a character created in that book.

create table if not exists book_franchises (
  book_id text not null references books (id),
  franchise_id text not null references franchises (id),
  position integer not null,
  primary key (book_id, franchise_id)
);

alter table book_franchises enable row level security;
create policy "public read" on book_franchises for select using (true);

-- works: one movie, show, game, comic run or podcast. The id is the slug of
-- the title, a hyphen and the year. Replaces the empty series table.

create table if not exists works (
  id text primary key,
  franchise_id text references franchises (id),
  title text not null,
  year integer not null,
  medium text not null
    check (medium in ('movie', 'animated_series', 'live_action', 'video_game', 'comic', 'podcast')),
  universe text
);

alter table works enable row level security;
create policy "public read" on works for select using (true);

-- appearances: who voiced a character in a work. Facts about the world only;
-- the voice columns of character_appearances do not carry over (R7). That
-- table stays until P6.

create table if not exists appearances (
  id uuid primary key default gen_random_uuid(),
  character_id text not null references characters (id),
  work_id text not null references works (id),
  voice_actor text,
  search_terms text[],
  notes text,
  constraint appearances_character_id_work_id_key unique (character_id, work_id)
);

create index if not exists appearances_work_id_idx on appearances (work_id);

alter table appearances enable row level security;
create policy "public read" on appearances for select using (true);

-- The project's default privileges give these roles nothing on a table
-- postgres creates, so the grants are explicit.
grant select on public.franchises to anon, authenticated;
grant select on public.book_franchises to anon, authenticated;
grant select on public.works to anon, authenticated;
grant select on public.appearances to anon, authenticated;
grant select, insert, update, delete on public.franchises to service_role;
grant select, insert, update, delete on public.book_franchises to service_role;
grant select, insert, update, delete on public.works to service_role;
grant select, insert, update, delete on public.appearances to service_role;

-- characters

alter table characters
  add column if not exists franchise_id text references franchises (id);

-- "Batman is a form of Bruce Wayne." Replaces voice_of, which stays until P2.
alter table characters
  add column if not exists form_of text references characters (id);

-- voices

alter table voices
  add column if not exists appearance_id uuid references appearances (id);

-- A plain unique constraint, not a partial index, so the voice-lab import
-- can upsert on the column. Nulls repeat freely (a designed voice has none).
alter table voices
  add constraint voices_appearance_id_key unique (appearance_id);

-- Replaces lab_default, which stays until P3.
alter table voices
  add column if not exists starting_pick boolean;

-- The live check allows active, archived and library. needs_clip is added;
-- library is kept because the deployed types still name it (no row uses it).
alter table voices drop constraint if exists voices_status_check;

alter table voices
  add constraint voices_status_check
    check (status in ('active', 'archived', 'library', 'needs_clip'));

-- castlist

-- The character is in the issue and has lines, and renders no audio. Replaces
-- the __SKIPPED__ marker in voice_id, which stays until P2.
alter table castlist
  add column if not exists no_audio boolean not null default false;

-- The unique index on (book_id, issue_id, character_id) waits for P2: the
-- deployed upserts still conflict on the text column and would trip it.

-- aliases

-- P4 stops writing canonical; P6 drops it.
alter table aliases
  alter column canonical drop not null;
