grant select on public.book_parts to anon, authenticated;
create policy "public read" on book_parts for select using (true);
