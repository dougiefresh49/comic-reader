create table panels (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  page_number integer not null,
  panel_id text not null,
  sort_order integer not null,
  bounding_box jsonb not null,
  cinematic_description text,
  effect_tags text[] not null default '{}',
  audio_tags jsonb not null default '{}',
  primary_speaker text,
  estimated_duration_seconds real,
  is_new_scene boolean not null default false,
  source text not null default 'gemini',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (book_id, issue_id) references issues (book_id, id) on delete cascade,
  unique (book_id, issue_id, panel_id)
);

alter table panels enable row level security;

grant select, insert, update, delete on public.panels to service_role;
grant select on public.panels to anon;

alter table bubbles add column if not exists panel_id uuid references panels (id) on delete set null;
