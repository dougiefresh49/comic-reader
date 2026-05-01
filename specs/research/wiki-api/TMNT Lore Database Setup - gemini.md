```sql
-- Run these in your Supabase SQL Editor to prepare for lore ingestion

-- 1. Setup Extensions
create extension if not exists vector;

-- 2. Enhance Books Table (if not already present)
alter table books add column if not exists wiki_url text;
alter table books add column if not exists summary text;

-- 3. Create Lore Snippet Table
create table if not exists book_lore (
id uuid primary key default gen_random_uuid(),
book_id uuid references books(id) on delete cascade,
content text not null,
metadata jsonb,
embedding vector(768), -- Size for Gemini 1.5
created_at timestamp with time zone default now()
);

-- 4. Create Character Mapping Table
create table if not exists character_annotations (
id uuid primary key default gen_random_uuid(),
book_id uuid references books(id) on delete cascade,
page_number int not null,
character_name text not null,
coordinates jsonb, -- Store as {x, y, w, h}
is_verified boolean default false,
created_at timestamp with time zone default now()
);

-- 5. Helper Function for Semantic Search
create or replace function match_book_lore (
query_embedding vector(768),
match_threshold float,
match_count int,
target_book_id uuid
)
returns table (
id uuid,
content text,
similarity float
)
language plpgsql
as $$
begin
return query
select
book_lore.id,
book_lore.content,
1 - (book_lore.embedding <=> query_embedding) as similarity
from book_lore
where book_lore.book_id = target_book_id
and 1 - (book_lore.embedding <=> query_embedding) > match_threshold
order by book_lore.embedding <=> query_embedding
limit match_count;
end;
$$;

```
