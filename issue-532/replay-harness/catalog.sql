-- Issue #532 schema comparison. One SELECT, read-only, run unchanged on production
-- (Supabase MCP execute_sql) and on the replay. Returns (c, k, d): category, stable key,
-- normalized definition. Long bodies are md5'd; diff.mjs fetches full text where they differ.
-- Objects owned by an extension (pg_depend deptype 'e', e.g. pgvector's functions in public) are left out.
-- Grants are read from the ACL columns via aclexplode (same data as information_schema.role_*_grants,
-- but not filtered by the reading role's memberships).
with
ext_objs as (
  select classid, objid from pg_depend where deptype = 'e'
),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl, c.relowner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r','p','v','m','S','f')
    and not exists (select 1 from ext_objs e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
),
grantees(oid, name) as (
  select 0::oid, 'PUBLIC'
  union all
  select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')
),
cat(c, k, d) as (
  -- tables
  select 'table', nspname||'.'||relname,
         'kind='||relkind::text||' rls='||relrowsecurity||' force_rls='||relforcerowsecurity
  from rels where relkind in ('r','p','f')
  union all
  -- columns
  select 'column', r.nspname||'.'||r.relname||'.'||a.attname,
         format_type(a.atttypid, a.atttypmod)
         ||case when a.attnotnull then ' not null' else '' end
         ||coalesce(' default '||case when a.attgenerated = '' then pg_get_expr(ad.adbin, ad.adrelid) end, '')
         ||case when a.attidentity <> '' then ' identity='||a.attidentity::text else '' end
         ||coalesce(' generated('||a.attgenerated::text||') '||case when a.attgenerated <> '' then pg_get_expr(ad.adbin, ad.adrelid) end, '')
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where r.relkind in ('r','p','f','v','m')
  union all
  -- constraints (not-null constraints are covered by columns; PG18 also lists them here as contype 'n')
  select 'constraint', r.nspname||'.'||r.relname||'.'||co.conname,
         co.contype::text||' '||pg_get_constraintdef(co.oid)
  from pg_constraint co join rels r on r.oid = co.conrelid
  where co.contype <> 'n'
  union all
  -- indexes
  select 'index', r.nspname||'.'||ic.relname, pg_get_indexdef(i.indexrelid)
  from pg_index i join rels r on r.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
  union all
  -- policies on public tables and on storage.objects
  select 'policy', p.schemaname||'.'||p.tablename||'.'||p.policyname,
         p.permissive||' cmd='||p.cmd
         ||' roles='||(select string_agg(x, ',' order by x collate "C") from unnest(p.roles) x)
         ||' qual='||coalesce(p.qual, '-')
         ||' check='||coalesce(p.with_check, '-')
  from pg_policies p
  where p.schemaname = 'public' or (p.schemaname = 'storage' and p.tablename = 'objects')
  union all
  -- functions and procedures
  select 'function', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         'returns='||pg_get_function_result(p.oid)
         ||' lang='||l.lanname||' kind='||p.prokind::text||' volatility='||p.provolatile::text
         ||' secdef='||p.prosecdef
         ||' config='||coalesce(array_to_string(p.proconfig, ';'), '-')
         ||' def_md5='||md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind in ('f','p')
    and not exists (select 1 from ext_objs e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
  union all
  -- triggers
  select 'trigger', r.nspname||'.'||r.relname||'.'||t.tgname,
         pg_get_triggerdef(t.oid)||case t.tgenabled when 'O' then '' else ' enabled='||t.tgenabled::text end
  from pg_trigger t join rels r on r.oid = t.tgrelid
  where not t.tgisinternal
  union all
  -- views
  select 'view', nspname||'.'||relname, 'kind='||relkind::text||' def_md5='||md5(pg_get_viewdef(oid))
  from rels where relkind in ('v','m')
  union all
  -- enum types
  select 'enum', n.nspname||'.'||t.typname,
         (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype = 'e'
    and not exists (select 1 from ext_objs e where e.classid = 'pg_type'::regclass and e.objid = t.oid)
  union all
  -- sequences
  select 'sequence', r.nspname||'.'||r.relname,
         format_type(s.seqtypid, null)||' start='||s.seqstart||' inc='||s.seqincrement
         ||' min='||s.seqmin||' max='||s.seqmax||' cache='||s.seqcache||' cycle='||s.seqcycle
         ||coalesce(' owned_by='||(select dr.relname||'.'||da.attname
                     from pg_depend d join pg_class dr on dr.oid = d.refobjid
                     join pg_attribute da on da.attrelid = d.refobjid and da.attnum = d.refobjsubid
                     where d.classid = 'pg_class'::regclass and d.objid = r.oid
                       and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i') limit 1), '')
  from rels r join pg_sequence s on s.seqrelid = r.oid
  union all
  -- table, view and sequence grants to anon / authenticated / service_role / PUBLIC
  select 'table_grant', r.nspname||'.'||r.relname||' to '||g.name,
         string_agg(a.privilege_type||case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type)
  from rels r
  cross join lateral aclexplode(coalesce(r.relacl, acldefault((case when r.relkind = 'S' then 's' else 'r' end)::"char", r.relowner))) a
  join grantees g on g.oid = a.grantee
  group by r.nspname, r.relname, g.name
  union all
  -- column grants
  select 'column_grant', r.nspname||'.'||r.relname||'.'||att.attname||' to '||g.name,
         string_agg(a.privilege_type||case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type)
  from rels r
  join pg_attribute att on att.attrelid = r.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
  cross join lateral aclexplode(att.attacl) a
  join grantees g on g.oid = a.grantee
  group by r.nspname, r.relname, att.attname, g.name
  union all
  -- function execute grants
  select 'function_grant', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') to '||g.name,
         string_agg(a.privilege_type||case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
  join grantees g on g.oid = a.grantee
  where n.nspname = 'public' and p.prokind in ('f','p')
    and not exists (select 1 from ext_objs e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
  group by n.nspname, p.proname, p.oid, g.name
  union all
  -- default privileges in schema public (pg_default_acl), per owner role and object type
  select 'default_acl', pg_get_userbyid(da.defaclrole)||' '||da.defaclobjtype::text||' to '||g.name,
         string_agg(a.privilege_type||case when a.is_grantable then '*' else '' end, ',' order by a.privilege_type)
  from pg_default_acl da join pg_namespace n on n.oid = da.defaclnamespace
  cross join lateral aclexplode(da.defaclacl) a
  join grantees g on g.oid = a.grantee
  where n.nspname = 'public' and pg_get_userbyid(da.defaclrole) = 'postgres'
  group by da.defaclrole, da.defaclobjtype, g.name
  union all
  -- comments on tables, columns, views, sequences
  select 'comment', r.nspname||'.'||r.relname||case when d.objsubid > 0 then '.'||att.attname else '' end,
         'md5='||md5(d.description)
  from pg_description d join rels r on d.classoid = 'pg_class'::regclass and d.objoid = r.oid
  left join pg_attribute att on att.attrelid = r.oid and att.attnum = d.objsubid
  union all
  -- comments on functions
  select 'comment', 'function '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         'md5='||md5(d.description)
  from pg_description d join pg_proc p on d.classoid = 'pg_proc'::regclass and d.objoid = p.oid
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from ext_objs e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
  union all
  -- comments on constraints, triggers, policies, types in public
  select 'comment', 'constraint '||r.nspname||'.'||r.relname||'.'||co.conname, 'md5='||md5(d.description)
  from pg_description d join pg_constraint co on d.classoid = 'pg_constraint'::regclass and d.objoid = co.oid
  join rels r on r.oid = co.conrelid
  union all
  select 'comment', 'trigger '||r.nspname||'.'||r.relname||'.'||t.tgname, 'md5='||md5(d.description)
  from pg_description d join pg_trigger t on d.classoid = 'pg_trigger'::regclass and d.objoid = t.oid
  join rels r on r.oid = t.tgrelid
  union all
  select 'comment', 'policy '||r.nspname||'.'||r.relname||'.'||po.polname, 'md5='||md5(d.description)
  from pg_description d join pg_policy po on d.classoid = 'pg_policy'::regclass and d.objoid = po.oid
  join rels r on r.oid = po.polrelid
  union all
  select 'comment', 'type '||n.nspname||'.'||t.typname, 'md5='||md5(d.description)
  from pg_description d join pg_type t on d.classoid = 'pg_type'::regclass and d.objoid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
    and not exists (select 1 from ext_objs e where e.classid = 'pg_type'::regclass and e.objid = t.oid)
  union all
  -- storage.buckets rows
  select 'bucket', b.id,
         'public='||coalesce(b.public::text, 'null')||' file_size_limit='||coalesce(b.file_size_limit::text, 'null')
         ||' allowed_mime_types='||coalesce(array_to_string(b.allowed_mime_types, ','), 'null')
  from storage.buckets b
)
select c, k, coalesce(d, '') as d from cat order by c collate "C", k collate "C"
