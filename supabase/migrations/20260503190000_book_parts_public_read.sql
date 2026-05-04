grant select on public.book_parts to anon, authenticated;
grant select, insert, update, delete on public.book_parts to service_role;
create policy "public read" on book_parts for select using (true);
