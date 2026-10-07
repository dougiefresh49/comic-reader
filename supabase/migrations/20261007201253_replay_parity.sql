-- Issue #532: a fresh replay of supabase/migrations did not build production's schema.
-- Four early migrations ran statements on production that their files lack (buckets,
-- storage policies, indexes, constraint names, a comment), and some objects were made by
-- hand (an RLS auto-enable event trigger, RLS on book_parts, stricter default privileges).
-- This file brings a replay (a preview branch) level with production and changes nothing
-- on production: every statement is guarded or idempotent, and applying it twice leaves the
-- catalog unchanged. The comparison and the evidence are on the issue. The hand-made
-- bb-restyle bucket is left out on purpose: no code references it.

-- ---------------------------------------------------------------------------
-- 1. Storage buckets: limits and MIME types that 20260428001138_create_storage_buckets
--    ran on production but its file lacks; face-exemplars from
--    20260506210526_face_exemplar_embeddings (apply-only).
-- ---------------------------------------------------------------------------
insert into storage.buckets as b (id, name, public, file_size_limit, allowed_mime_types)
values
  ('comic-pages',       'comic-pages',       true,  10485760, array['image/webp', 'image/jpeg']),
  ('comic-audio',       'comic-audio',       true,  10485760, array['audio/mpeg']),
  ('comic-ocr-crops',   'comic-ocr-crops',   false, 5242880,  array['image/webp', 'application/json']),
  ('comic-pages-raw',   'comic-pages-raw',   false, 20971520, array['image/jpeg', 'image/png']),
  ('comic-voice-clips', 'comic-voice-clips', false, 52428800, array['audio/mpeg', 'audio/mp4', 'audio/wav']),
  ('face-exemplars',    'face-exemplars',    true,  5242880,  array['image/jpeg', 'image/png'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types
  where b.file_size_limit is distinct from excluded.file_size_limit
     or b.allowed_mime_types is distinct from excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Storage policies on storage.objects (apply-only: create_storage_buckets,
--    face_exemplar_embeddings).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'public read comic-pages') then
    create policy "public read comic-pages" on storage.objects for select using (bucket_id = 'comic-pages');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'public read comic-audio') then
    create policy "public read comic-audio" on storage.objects for select using (bucket_id = 'comic-audio');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'public read face exemplars') then
    create policy "public read face exemplars" on storage.objects for select to public using (bucket_id = 'face-exemplars');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'service role upload face exemplars') then
    create policy "service role upload face exemplars" on storage.objects for insert to service_role with check (bucket_id = 'face-exemplars');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'service role update face exemplars') then
    create policy "service role update face exemplars" on storage.objects for update to service_role using (bucket_id = 'face-exemplars');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'service role delete face exemplars') then
    create policy "service role delete face exemplars" on storage.objects for delete to service_role using (bucket_id = 'face-exemplars');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes (apply-only: 20260428001207_initial_schema, 20260428214101_add_panels_table_and_bubble_fk).
-- ---------------------------------------------------------------------------
create index if not exists aliases_lookup on public.aliases using btree (alias, scope, scope_id);
create index if not exists audio_timestamps_issue on public.audio_timestamps using btree (book_id, issue_id);
create index if not exists bubbles_legacy on public.bubbles using btree (book_id, issue_id, legacy_id);
create index if not exists bubbles_page on public.bubbles using btree (book_id, issue_id, page_number, sort_order);
create index if not exists bubbles_panel_idx on public.bubbles using btree (panel_id);
create index if not exists casting_tasks_pending on public.casting_tasks using btree (book_id, issue_id, status) where (status = 'pending'::text);
create index if not exists panels_page_idx on public.panels using btree (book_id, issue_id, page_number, sort_order);
create index if not exists pipeline_runs_issue on public.pipeline_runs using btree (book_id, issue_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 4. panels constraint names (apply-only: add_panels_table_and_bubble_fk named them;
--    the file leaves them to the default names). Renaming the unique constraint renames its index.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.panels'::regclass and conname = 'panels_book_id_issue_id_fkey')
     and not exists (select 1 from pg_constraint where conrelid = 'public.panels'::regclass and conname = 'panels_book_issue_fkey') then
    alter table public.panels rename constraint panels_book_id_issue_id_fkey to panels_book_issue_fkey;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.panels'::regclass and conname = 'panels_book_id_issue_id_panel_id_key')
     and not exists (select 1 from pg_constraint where conrelid = 'public.panels'::regclass and conname = 'panels_panel_id_unique') then
    alter table public.panels rename constraint panels_book_id_issue_id_panel_id_key to panels_panel_id_unique;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Column comment (apply-only: 20260501202530_panels_foreground_polygons ran this text).
-- ---------------------------------------------------------------------------
comment on column public.panels.foreground_polygons is
  'SAM3 segmentation polygons normalized to panel-local 0..1. Shape: {characters: [[{x,y},...]], bubbles: [[{x,y},...]]}. Populated by extract-foreground-masks ingest step. Null when not yet processed.';

-- ---------------------------------------------------------------------------
-- 6. RLS auto-enable event trigger (hand-made on production: no recorded statement holds it),
--    and RLS on book_parts (hand-made, or set by that trigger when book_parts was created).
-- ---------------------------------------------------------------------------
do $fix$
begin
  if to_regprocedure('public.rls_auto_enable()') is null then
    execute $ddl$
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
$ddl$;
    grant execute on function public.rls_auto_enable() to anon, authenticated, service_role;
  end if;
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
end $fix$;

alter table public.book_parts enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Grants. Production's default privileges for role postgres in schema public give
--    anon/authenticated/service_role no select/insert/update/delete on new tables, no
--    select/usage on new sequences, and no execute on new functions. Stock Supabase gives all.
--    No migration holds that setting (hand-made). Revoking what a role does not hold is a no-op.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke select, usage on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;

-- Per-object grants: generated by 532-replay/gen-grant-fix.mjs from the comparison.
revoke execute on function public.match_face_exemplars(query_embedding vector, book_ids text[], match_limit integer) from anon;
revoke execute on function public.match_face_exemplars(query_embedding vector, book_ids text[], match_limit integer) from authenticated;
revoke execute on function public.panel_box_usable(box jsonb) from anon;
revoke execute on function public.panel_box_usable(box jsonb) from authenticated;
revoke execute on function public.panel_box_usable(box jsonb) from service_role;
revoke execute on function public.remap_panel_face_boxes() from anon;
revoke execute on function public.remap_panel_face_boxes() from authenticated;
revoke execute on function public.remap_panel_face_boxes() from service_role;
revoke execute on function public.remap_panel_foreground_polygons() from anon;
revoke execute on function public.remap_panel_foreground_polygons() from authenticated;
revoke execute on function public.remap_panel_foreground_polygons() from service_role;
revoke delete, insert, update on table public.aliases from anon;
revoke delete, insert, select, update on table public.aliases from authenticated;
revoke select, usage on sequence public.aliases_id_seq from anon;
revoke select, usage on sequence public.aliases_id_seq from authenticated;
revoke delete, insert, update on table public.appearances from anon;
revoke delete, insert, update on table public.appearances from authenticated;
revoke delete, insert, update on table public.audio_timestamps from anon;
revoke delete, insert, select, update on table public.audio_timestamps from authenticated;
revoke delete, insert, update on table public.book_franchises from anon;
revoke delete, insert, update on table public.book_franchises from authenticated;
revoke delete, insert, update on table public.book_parts from anon;
revoke delete, insert, update on table public.book_parts from authenticated;
revoke delete, insert, update on table public.books from anon;
revoke delete, insert, select, update on table public.books from authenticated;
revoke delete, insert, update on table public.bubbles from anon;
revoke delete, insert, select, update on table public.bubbles from authenticated;
revoke delete, insert, select, update on table public.casting_tasks from anon;
revoke delete, insert, select, update on table public.casting_tasks from authenticated;
revoke delete, insert, update on table public.castlist from anon;
revoke delete, insert, select, update on table public.castlist from authenticated;
revoke delete, insert, update on table public.character_face_exemplars from anon;
revoke delete, insert, select, update on table public.character_face_exemplars from authenticated;
revoke delete, insert, update on table public.characters from anon;
revoke delete, insert, select, update on table public.characters from authenticated;
revoke delete, insert, update on table public.franchises from anon;
revoke delete, insert, update on table public.franchises from authenticated;
revoke delete, insert, update on table public.issues from anon;
revoke delete, insert, select, update on table public.issues from authenticated;
revoke delete, insert, select, update on table public.llm_calls from anon;
revoke delete, insert, select, update on table public.llm_calls from authenticated;
revoke delete, update on table public.llm_calls from service_role;
revoke delete, insert, update on table public.music_scenes from anon;
revoke delete, insert, select, update on table public.music_scenes from authenticated;
revoke delete, insert, select, update on table public.page_context from anon;
revoke delete, insert, select, update on table public.page_context from authenticated;
revoke delete, insert, update on table public.page_segmentation from anon;
revoke delete, insert, select, update on table public.page_segmentation from authenticated;
revoke delete, insert, update on table public.pages from anon;
revoke delete, insert, select, update on table public.pages from authenticated;
revoke select, usage on sequence public.pages_id_seq from anon;
revoke select, usage on sequence public.pages_id_seq from authenticated;
revoke delete, insert, update on table public.panel_character_detections from anon;
revoke delete, insert, select, update on table public.panel_character_detections from authenticated;
revoke delete, insert, update on table public.panels from anon;
revoke delete, insert, update on table public.panels from authenticated;
revoke delete, insert, select, update on table public.pipeline_runs from anon;
revoke delete, insert, select, update on table public.pipeline_runs from authenticated;
revoke delete, insert, update on table public.voice_archives from anon;
revoke delete, insert, select, update on table public.voice_archives from authenticated;
revoke delete, insert, select, update on table public.voice_lookups from anon;
revoke delete, insert, select, update on table public.voice_lookups from authenticated;
revoke delete, insert, update on table public.voices from anon;
revoke delete, insert, select, update on table public.voices from authenticated;
revoke delete, insert, update on table public.works from anon;
revoke delete, insert, update on table public.works from authenticated;
