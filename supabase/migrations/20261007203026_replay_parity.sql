-- Issue #532: a fresh replay of supabase/migrations did not build production's schema.
-- Six early migrations ran statements on production that their files lack (bucket
-- limits, storage policies, indexes, constraint names, grants, a comment), one file grants
-- anon reads that production refused, and some objects were made by hand (an RLS
-- auto-enable event trigger, RLS on book_parts, a sequence default privilege). This file
-- brings a replay (a preview branch) level with production and changes nothing on
-- production: every statement is guarded or idempotent, and applying it twice leaves the
-- catalog unchanged. The comparison and the evidence are
-- on the issue. The hand-made bb-restyle bucket is left out on purpose: no code references it.

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
-- 7. Grants production holds that a preview branch lacks. A branch starts with
--    production's default privileges for role postgres in schema public (tables and
--    functions match; sequences are stricter), so the only gaps are three grants:
--    two that early migrations ran on production but their files lack, and one made by
--    hand. Every statement grants what production already holds, so it is a no-op there.
-- ---------------------------------------------------------------------------
-- apply-only, 20260428214101_add_panels_table_and_bubble_fk: recorded `GRANT SELECT ON panels TO authenticated;`
grant select on public.panels to authenticated;

-- apply-only, 20260428001610_grant_service_role_access: recorded `grant all on all sequences in schema public to service_role;`
-- (at that version the only sequences were aliases_id_seq and pages_id_seq)
grant select, update, usage on sequence public.aliases_id_seq, public.pages_id_seq to service_role;

-- hand-made on production: default privileges for role postgres in schema public give UPDATE on sequences
-- to anon, authenticated and service_role, and the two existing sequences carry that grant.
alter default privileges for role postgres in schema public grant update on sequences to anon, authenticated, service_role;
grant update on sequence public.aliases_id_seq, public.pages_id_seq to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Grants the files hold that production does not (file-only). The recorded
--    20260428014010_grant_anon_read_access ends with "Admin tables intentionally omitted:
--    speaker_reviews, casting_tasks, pipeline_runs, page_context"; the file grants anon
--    SELECT on all four (speaker_reviews was dropped since). Production holds none of the
--    three. Revoking a privilege a role does not hold is a no-op on production.
-- ---------------------------------------------------------------------------
revoke select on public.casting_tasks, public.page_context, public.pipeline_runs from anon;
