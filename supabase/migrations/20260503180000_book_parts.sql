-- Book Parts: optional sub-grouping for multi-part series (e.g., TMNT x MMPR Part I/II/III)
create table book_parts (
  id text primary key,
  book_id text not null references books (id),
  number integer not null,
  name text not null,
  slug text not null,
  wiki_url text,
  total_issues integer,
  created_at timestamptz default now(),
  unique (book_id, number)
);

create index book_parts_book_id on book_parts (book_id);

-- New columns on books (wiki_host and wiki_title_template already exist)
alter table books
  add column if not exists total_issues integer,
  add column if not exists publisher text,
  add column if not exists franchises text[];

-- New columns on issues
alter table issues
  add column if not exists part_id text references book_parts (id),
  add column if not exists source_url text,
  add column if not exists wiki_url text;
