create type alias_scope as enum ('global', 'series', 'book');

create table series (
  id text primary key,
  name text not null,
  created_at timestamptz default now()
);

create table books (
  id text primary key,
  series_id text references series (id),
  name text not null,
  slug text not null unique,
  created_at timestamptz default now()
);

create table issues (
  book_id text not null references books (id),
  id text not null,
  number integer not null,
  name text not null,
  page_count integer not null default 0,
  bubble_count integer not null default 0,
  audio_count integer not null default 0,
  has_webp boolean not null default false,
  has_audio boolean not null default false,
  has_timestamps boolean not null default false,
  status text not null default 'pending',
  source_pages_path text,
  pipeline_step text,
  pipeline_paused boolean not null default false,
  pipeline_paused_at text,
  pipeline_paused_url text,
  created_at timestamptz default now(),
  primary key (book_id, id)
);

create table pages (
  id serial primary key,
  book_id text not null,
  issue_id text not null,
  number integer not null,
  width integer not null,
  height integer not null,
  storage_path text,
  foreign key (book_id, issue_id) references issues (book_id, id),
  unique (book_id, issue_id, number)
);

create table bubbles (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  book_id text not null,
  issue_id text not null,
  page_number integer not null,
  sort_order integer not null,
  ocr_text text,
  text_with_cues text,
  type text not null default 'SPEECH',
  speaker text,
  emotion text,
  character_type text,
  side text,
  voice_description text,
  ai_reasoning text,
  ignored boolean not null default false,
  needs_audio boolean not null default false,
  needs_ocr boolean not null default false,
  box_2d jsonb,
  style jsonb,
  audio_storage_path text,
  crop_storage_path text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  foreign key (book_id, issue_id) references issues (book_id, id),
  unique (book_id, issue_id, legacy_id)
);

create table audio_timestamps (
  bubble_id uuid primary key references bubbles (id) on delete cascade,
  book_id text not null,
  issue_id text not null,
  alignment jsonb,
  normalized_alignment jsonb,
  created_at timestamptz default now()
);

create table castlist (
  book_id text not null,
  issue_id text not null,
  character text not null,
  voice_id text,
  foreign key (book_id, issue_id) references issues (book_id, id),
  primary key (book_id, issue_id, character)
);

create table characters (
  id text primary key,
  franchise text,
  aliases text[] not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table character_appearances (
  id text primary key,
  character_id text not null references characters (id),
  media_title text,
  year integer,
  voice_actor text,
  media_type text,
  youtube_search_terms text[],
  notes text,
  voice_id text,
  voice_type text,
  voice_status text,
  voice_description text,
  voice_created_at timestamptz,
  clip_storage_path text,
  clip_source_url text,
  clip_duration_secs double precision,
  voice_model_status text not null default 'pending',
  voice_model_error text,
  voice_model_started_at timestamptz,
  created_at timestamptz default now()
);

create table aliases (
  id serial primary key,
  alias text not null,
  canonical text not null,
  scope alias_scope not null default 'global',
  scope_id text,
  created_at timestamptz default now(),
  unique (alias, scope, scope_id)
);

create table speaker_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  original_name text not null,
  resolved_name text,
  status text not null default 'pending',
  auto_accepted boolean not null default false,
  save_as_alias boolean not null default false,
  alias_scope text,
  sample_text text,
  page_numbers integer[],
  bubble_count integer not null default 0,
  reviewed_at timestamptz,
  created_at timestamptz default now(),
  foreign key (book_id, issue_id) references issues (book_id, id),
  unique (book_id, issue_id, original_name)
);

create table page_context (
  book_id text not null,
  issue_id text not null,
  page_number integer not null,
  gemini_model text,
  raw_response jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (book_id, issue_id, page_number),
  foreign key (book_id, issue_id) references issues (book_id, id)
);

create table pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  started_at timestamptz default now(),
  completed_at timestamptz,
  status text not null default 'running',
  steps jsonb,
  foreign key (book_id, issue_id) references issues (book_id, id)
);

create table casting_tasks (
  id uuid primary key default gen_random_uuid(),
  book_id text not null,
  issue_id text not null,
  character_id text not null references characters (id),
  status text not null default 'pending',
  created_at timestamptz default now(),
  completed_at timestamptz,
  foreign key (book_id, issue_id) references issues (book_id, id),
  unique (book_id, issue_id, character_id)
);

alter table series enable row level security;
alter table books enable row level security;
alter table issues enable row level security;
alter table pages enable row level security;
alter table bubbles enable row level security;
alter table audio_timestamps enable row level security;
alter table castlist enable row level security;
alter table characters enable row level security;
alter table character_appearances enable row level security;
alter table aliases enable row level security;
alter table speaker_reviews enable row level security;
alter table page_context enable row level security;
alter table pipeline_runs enable row level security;
alter table casting_tasks enable row level security;
