-- Voice rotation schema (roadmap 04-voice-rotation.md).
--
-- Purpose: keep the active ElevenLabs IVC count below the 30-voice
-- Creator-tier cap by archiving voices that aren't currently in use,
-- and restoring them on demand. Without this, ingesting more than 2-3
-- new books exhausts the cap.
--
-- Today: castlist.voice_id is the ElevenLabs voice id, used directly.
-- After: we add `voices` as a stable indirection so the EL id can
-- rotate (delete + recreate) without losing the link from a character
-- to its source clip + settings. voice_archives is the append-only
-- audit log of every archive event.

create table if not exists voices (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  series_id text,
  status text not null
    check (status in ('active', 'archived', 'library')),
  -- ElevenLabs ID currently active in EL. NULL when archived.
  current_elevenlabs_id text,
  voice_settings jsonb,
  -- Storage path to the source audio used to (re)create the voice.
  -- For library voices, this is null — they're community voices we
  -- pin by EL id only.
  source_clip_path text,
  -- For Voice Design voices (no source clip), the original prompt
  -- so we can recreate the voice deterministically.
  design_prompt text,
  -- "Don't archive me on book publish." Set true for main-cast voices
  -- that appear across many books — archiving them just to recreate
  -- next ingest is wasteful.
  keep_active boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- A given EL id is only ever owned by one of our voices at a time.
-- Archived voices have current_elevenlabs_id = null, so the partial
-- unique index avoids conflicts during archive/restore cycles.
create unique index if not exists voices_current_el_id_uniq
  on voices (current_elevenlabs_id)
  where current_elevenlabs_id is not null;

create index if not exists voices_status_idx on voices (status);
create index if not exists voices_series_id_idx on voices (series_id);

create table if not exists voice_archives (
  id uuid primary key default gen_random_uuid(),
  voice_id uuid not null references voices (id) on delete cascade,
  -- The EL id that existed before this archive event. Useful for
  -- correlating with EL audit logs / recovery scenarios.
  former_elevenlabs_id text not null,
  archived_at timestamptz not null default now(),
  -- Which book triggered the archive (the publish event that freed
  -- the slot). Null for manual archives.
  archived_for_book_id text
);

create index if not exists voice_archives_voice_id_idx
  on voice_archives (voice_id);
create index if not exists voice_archives_archived_at_idx
  on voice_archives (archived_at desc);

-- Castlist gets a stable handle to its voice. Existing castlist.voice_id
-- (text, ElevenLabs id) stays as the actively-used id; voice_uuid is
-- the rotation-safe pointer.
--
-- Eventually castlist.voice_id can become a generated column derived
-- from voices.current_elevenlabs_id, but for now we update both in
-- the rotation script to keep the audio-gen path unchanged.
alter table castlist
  add column if not exists voice_uuid uuid references voices (id);

create index if not exists castlist_voice_uuid_idx
  on castlist (voice_uuid);

-- castlist.voice_id was NOT NULL. After archiving, the EL id may be
-- temporarily null until checkout restores it. Make it nullable.
alter table castlist
  alter column voice_id drop not null;

-- Public read on voices is fine — these are non-sensitive metadata.
-- Writes happen from the pipeline using the service-role key.
alter table voices enable row level security;
alter table voice_archives enable row level security;

drop policy if exists voices_public_read on voices;
create policy voices_public_read on voices
  for select using (true);

drop policy if exists voice_archives_public_read on voice_archives;
create policy voice_archives_public_read on voice_archives
  for select using (true);
