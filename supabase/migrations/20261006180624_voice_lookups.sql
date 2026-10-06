-- voice_lookups (#474): what a GEMINI_FAST lookup said about how one
-- character sounds in one work, the description and labels the voice-lab
-- import copies onto a voice row that lacks them. The voice row is the home
-- of a voice's description and labels; this row is read only while the voice
-- lacks them, and stays afterward as the record of what the model said.
--
-- Additive only: one new table that nothing else reads.
--
-- RLS on, like every table the casting data model added. Only the import
-- reads or writes it, with the service role, so no public read policy.

create table if not exists voice_lookups (
  character_id text not null references characters (id),
  work_id text not null references works (id),
  description text not null check (btrim(description) <> ''),
  labels jsonb not null check (jsonb_typeof(labels) = 'object'),
  model text not null,
  created_at timestamptz not null default now(),
  primary key (character_id, work_id)
);

create index if not exists voice_lookups_work_id_idx on voice_lookups (work_id);

alter table voice_lookups enable row level security;

-- The project's default privileges give these roles nothing on a table
-- postgres creates, so the grant is explicit.
grant select, insert, update, delete on public.voice_lookups to service_role;
