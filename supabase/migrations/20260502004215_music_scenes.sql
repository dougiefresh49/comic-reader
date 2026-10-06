-- Music scenes: group consecutive panels with similar music moods
-- into continuous runs so the runtime doesn't restart the bed every panel.

create table music_scenes (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  music_mood text not null,
  start_panel_id uuid references panels(id),
  end_panel_id uuid references panels(id),
  label text,
  created_at timestamptz default now(),
  unique (start_panel_id)
);

alter table panels add column scene_id uuid references music_scenes(id);

alter table music_scenes enable row level security;
create policy "public read music_scenes" on music_scenes for select using (true);
grant select on music_scenes to anon;
grant all on music_scenes to service_role;
