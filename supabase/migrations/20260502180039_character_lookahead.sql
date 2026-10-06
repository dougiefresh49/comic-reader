-- Character lookahead: face detection → CLIP embedding → clustering → identification
-- Tracks per-panel face detections linked to identified characters.

create table panel_character_detections (
  id uuid primary key default gen_random_uuid(),
  character_id text not null references characters (id),
  panel_id uuid not null references panels (id) on delete cascade,
  face_bbox jsonb not null,
  cluster_id integer,
  identification_confidence float not null default 0,
  human_verified boolean not null default false,
  created_at timestamptz not null default now()
);

alter table panel_character_detections enable row level security;
create policy "public read" on panel_character_detections for select using (true);
grant select on public.panel_character_detections to anon;
grant select, insert, update, delete on public.panel_character_detections to service_role;

create index idx_panel_char_det_panel on panel_character_detections (panel_id);
create index idx_panel_char_det_character on panel_character_detections (character_id);

-- Stable FK replacing freeform bubbles.speaker text field
alter table bubbles add column if not exists character_id text references characters (id);
