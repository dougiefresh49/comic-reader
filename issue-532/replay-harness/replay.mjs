// Issue #532: replay supabase/migrations into a fresh PGlite database on a stock Supabase baseline.
// Usage: node replay.mjs [--fix ../532-fix.sql [--twice]] [--baseline branch] [--out file.json]   (always starts from an empty data dir)
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIG = process.env.MIG ?? new URL('../../../supabase/migrations', import.meta.url).pathname; // or set MIG to a checkout's supabase/migrations
const DATA = join(here, 'pgdata');
const fixIdx = process.argv.indexOf('--fix');
const fixFile = fixIdx > 0 ? process.argv[fixIdx + 1] : null;
const bIdx = process.argv.indexOf('--baseline');
const branchBaseline = bIdx > 0 && process.argv[bIdx + 1] === 'branch';
const outIdx = process.argv.indexOf('--out');

rmSync(DATA, { recursive: true, force: true });
const db = await PGlite.create({ dataDir: DATA, extensions: { vector, pgcrypto, uuid_ossp } });

// Stock Supabase baseline (see report: stock default privileges are an assumption, not confirmed from source).
const baseline = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_admin login superuser;
create role supabase_storage_admin login noinherit createrole;
grant anon, authenticated, service_role to authenticator;
create schema if not exists extensions;
create schema storage;
create schema supabase_migrations;
create extension vector schema public;
create extension pgcrypto schema extensions;
create extension "uuid-ossp" schema extensions;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
grant usage on schema storage to postgres, anon, authenticated, service_role;
${branchBaseline
  // --baseline branch: the default privileges PR #617's preview branch held (pg_default_acl read 2026-10-07)
  ? `alter default privileges for role postgres in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;`
  : `alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;`}
create type storage.buckettype as enum ('STANDARD', 'ANALYTICS', 'VECTOR');
-- stub: production's columns for storage.buckets and storage.objects (information_schema.columns, 2026-10-07)
create table storage.buckets (
  id text not null primary key,
  name text not null,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text,
  type storage.buckettype not null default 'STANDARD'::storage.buckettype,
  versioning_status text not null default 'DISABLED'::text,
  lifecycle_configuration jsonb,
  lifecycle_configuration_generation uuid
);
create table storage.objects (
  id uuid not null primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[],
  version text,
  owner_id text,
  user_metadata jsonb,
  archived_at timestamptz,
  is_delete_marker boolean not null default false,
  is_versioned boolean not null default false
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
`;
await db.exec(baseline);
// Supabase sets search_path "$user", public, extensions for postgres
await db.exec(`set search_path to "$user", public, extensions`);
console.log('baseline ok');

const files = readdirSync(MIG).filter(f => /^\d{14}_.*\.sql$/.test(f)).sort();
let failed = null;
const log = [];
for (const f of files) {
  const version = f.slice(0, 14), name = f.slice(15, -4);
  const sql = readFileSync(join(MIG, f), 'utf8');
  try {
    await db.exec('begin;');
    await db.exec(sql);
    await db.query('insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)', [version, name, [sql]]);
    await db.exec('commit;');
    log.push(`${version} ${name} ok`);
  } catch (e) {
    try { await db.exec('rollback;'); } catch {}
    log.push(`${version} ${name} ERROR: ${e.message}`);
    failed = f;
  }
  console.log(log.at(-1));
  if (failed) break;
}
console.log(failed ? `replay stopped at ${failed}` : `replay complete: ${files.length} files`);

const twice = process.argv.includes('--twice');
if (fixFile && !failed) {
  for (let pass = 1; pass <= (twice ? 2 : 1); pass++) {
    if (pass === 2) {
      const before = await db.query(readFileSync(join(here, 'catalog.sql'), 'utf8'));
      writeFileSync(join(here, 'replay-fixed-pass1.json'), JSON.stringify(before.rows));
    }
    try {
      await db.exec('begin;');
      await db.exec(readFileSync(fixFile, 'utf8'));
      await db.exec('commit;');
      console.log(`fix pass ${pass} ${fixFile} ok`);
    } catch (e) {
      try { await db.exec('rollback;'); } catch {}
      console.log(`fix pass ${pass} ${fixFile} ERROR: ${e.message}`);
    }
  }
  const et = await db.query(`select evtname, evtevent, evtfoid::regproc::text as fn, array_to_string(evttags, ',') as tags from pg_event_trigger`);
  console.log('event triggers:', JSON.stringify(et.rows));
}

const catalog = readFileSync(join(here, 'catalog.sql'), 'utf8');
const res = await db.query(catalog);
const out = outIdx > 0 ? process.argv[outIdx + 1] : fixFile ? (process.argv.includes('--twice') ? 'replay-fixed-pass2.json' : 'replay-fixed.json') : 'replay.json';
writeFileSync(join(here, out), JSON.stringify(res.rows, null, 0));
console.log(`catalog: ${res.rows.length} rows -> ${out}`);
await db.close();
