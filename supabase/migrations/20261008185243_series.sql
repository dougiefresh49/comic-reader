-- Series (#675, decisions row 417 from #64): one book per volume, and a series
-- groups the volumes. Replaces book_parts, which stored the whole three-volume
-- run as one book. tmnt-mmpr-iii is volume III of the tmnt-mmpr series, with 5
-- issues; volumes I and II get their own books through add-book later.
--
-- series copies book_parts' public read (RLS on, a "public read" select
-- policy, select for anon and authenticated, all for service_role). No guards:
-- the apply should fail loudly on a schema it does not expect. No issues row,
-- child row or Storage path moves.

create table public.series (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.series enable row level security;
create policy "public read" on public.series for select using (true);
grant select on public.series to anon, authenticated;
grant all on public.series to service_role;

alter table public.books
  add column series_id text references public.series (id),
  add column series_position integer,
  add constraint books_series_id_series_position_key unique (series_id, series_position);

insert into public.series (id, name)
values ('tmnt-mmpr', 'Mighty Morphin Power Rangers/Teenage Mutant Ninja Turtles');

update public.books
set series_id = 'tmnt-mmpr', series_position = 3, total_issues = 5
where id = 'tmnt-mmpr-iii';

alter table public.issues drop column part_id;
drop table public.book_parts;
