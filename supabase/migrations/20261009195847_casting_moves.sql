-- Casting moves (#786): the run record of a whole casting change, the column
-- for a voice made for one run, and the owners of voices on the ElevenLabs
-- account that this repo has no voices row for.
--
-- Additive only: two new tables and one column with a default. Every
-- statement runs inside the migration's transaction.
--
-- 1. casting_moves: one row per staged move, written when the owner confirms
--    (never while he is staging), all of one confirm under one run_id and
--    numbered in run order by seq. operation is the in-flight record runMoves
--    writes before and after each external call, the role
--    casting_tasks.operation plays for the voices stop; operation_at is when
--    a live run last wrote it (database clock). casting_tasks is not widened:
--    its unique key (book_id, issue_id, character_id) cannot hold an archive
--    of a voice no character in the issue owns. character_id has no foreign
--    key, because an add_character move names a character its run creates.
--
-- 2. voices.run_only: a voice made for one issue's run, cast in that issue
--    only. Archiving it after its audio renders is a follow-up issue.
--
-- 3. account_voice_owners: which project holds an ElevenLabs voice this repo
--    has no voices row for, and whether it is pinned (never archived from
--    here). The owner fills it by hand; an unlisted voice shows as
--    "Other project".
--
-- RLS on with no public policy, like casting_tasks and every table the
-- casting data model added: only server code with the service role reads or
-- writes them.

-- 1. casting_moves

create table casting_moves (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  run_id uuid not null,
  seq int not null,
  kind text not null check (
    kind in (
      'archive',
      'restore',
      'create_design',
      'cast',
      'stand_in',
      'sit_out',
      'back_in',
      'add_character',
      'remove_character',
      'rename'
    )
  ),
  character_id text,
  voice_uuid uuid references voices (id) on delete set null,
  replaces_voice_uuid uuid references voices (id) on delete set null,
  backup boolean not null default true,
  lossy_ok boolean not null default false,
  run_only boolean not null default false,
  generated_voice_id text,
  design_prompt text,
  preview_text text,
  payload jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'done', 'failed', 'needs_attention')
  ),
  operation jsonb,
  operation_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (book_id, issue_id) references issues (book_id, id),
  unique (run_id, seq)
);

create index casting_moves_run_id_idx on casting_moves (run_id);

alter table casting_moves enable row level security;

-- The project's default privileges give these roles nothing on a table
-- postgres creates, so the grant is explicit.
grant select, insert, update, delete on public.casting_moves to service_role;

comment on column public.casting_moves.operation is
  'The in-flight record runMoves writes before and after each external call (#786), with its phase history. Kept after the move settles, as the run log.';

comment on column public.casting_moves.operation_at is
  'When a live runMoves last wrote this row''s operation record (database clock). A run that returns clears it once the last request''s outcome is known.';

-- 2. voices.run_only

alter table voices add column run_only boolean not null default false;

comment on column public.voices.run_only is
  'Made for one issue''s run (#786): cast in that issue only.';

-- 3. account_voice_owners

create table account_voice_owners (
  elevenlabs_id text primary key,
  project_name text not null,
  pinned boolean not null default false
);

alter table account_voice_owners enable row level security;

grant select, insert, update, delete on public.account_voice_owners to service_role;
