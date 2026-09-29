-- One row per paid Gemini or ElevenLabs request from the pipeline and the
-- review actions (#93). Written by src/lib/llm-usage.ts with the service role;
-- RLS is on with no policy, so anon and authenticated read nothing.
create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  provider text,
  step text,
  model text,
  service_tier text,
  book_id text,
  issue_id text,
  page_number int,
  tokens_in int,
  tokens_out int,
  tokens_thinking int,
  characters int,
  usd_est numeric(10,5),
  duration_ms int,
  ok boolean,
  error text
);

create index llm_calls_book_issue_created_idx
  on llm_calls (book_id, issue_id, created_at);

alter table llm_calls enable row level security;

grant select, insert on public.llm_calls to service_role;
