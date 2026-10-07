# Issue #532 replay comparison: report

[#532](https://github.com/dougiefresh49/comic-reader/issues/532) "A fresh replay of supabase/migrations may not build production's schema". This covers spec step 1 (the comparison) and a draft of step 3 (the fix). Nothing was written to production. Nothing was committed.

## Verdict

The answer is no: a fresh replay does not build production's schema. All 49 files replay without error, but the result differs from production in **109 catalog rows** across nine categories. Every difference is either `apply-only` (production ran SQL that the file lacks; 4 migrations) or `hand-made` (nothing in `schema_migrations.statements` holds it). The comparison found no `file-only` items. It also found no `harness` items: the rows outside the categories compared are listed under "What I could not verify". With the draft fix `/tmp/comic-reader-briefs/532-fix.sql` applied after the 49 files, the replay's catalog is **identical to production's** (0 differences, same md5 `612b5dd7333c870cd78724d10f306a68` over all 573 rows). Applying the fix a second time changes nothing.

## Engine

- **PGlite 0.5.8, which is PostgreSQL 18.3 in WASM**, not 17 as the brief said (`select version()` → `PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten`). Production is `PostgreSQL 17.6 on aarch64-unknown-linux-gnu`.
- pgvector comes from the separate package `@electric-sql/pglite-pgvector` 0.0.9 (vector 0.8.1); 0.5.8 core has no vector export. pgcrypto 1.4 and uuid-ossp 1.1 come from `@electric-sql/pglite/contrib/*`. Production has vector 0.8.0 and pgcrypto 1.3.
- Roles, extensions, default privileges, an event trigger and every migration statement ran in PGlite, so I did not need the postgresql@17 fallback. The one PG18 accommodation: `catalog.sql` skips `pg_constraint` rows with `contype = 'n'`, the not-null constraints PG18 records there. Not-null is still compared, through the column rows. After the fix nothing differed, so the version gap produced no noise in the categories compared.
- Baseline, from `replay.mjs`: roles `anon`, `authenticated`, `service_role` (nologin), `authenticator`, `supabase_admin`, `supabase_storage_admin`; schemas `extensions`, `storage`, `supabase_migrations`; stub `storage.buckets`/`storage.objects` with production's 14/15 columns; stock default privileges, `alter default privileges for role postgres in schema public grant all on tables|sequences|functions to anon, authenticated, service_role`; search_path `"$user", public, extensions`. Each file runs in its own transaction as superuser `postgres`.
- **Assumption kept, not confirmed:** that stock Supabase has those `postgres`-role default privileges in `public`, and that a preview branch starts from stock. In about four minutes of reading `supabase/postgres@develop` I found only the `supabase_admin` form (`migrations/db/init-scripts/00000000000000-initial-schema.sql:40-42`, which runs as supabase_admin, plus `:51-55` `for user supabase_admin`). I found nothing setting `for role postgres in schema public`. Production also holds the stock `supabase_admin` rows (`supabase_admin r public {...anon=arwdDxtm...}`), which fits that source. Where the `postgres`-role row on a fresh project comes from is unconfirmed.

## Replay log (check 1)

`rm -rf pgdata && node replay.mjs` (full log: `532-replay/replay.log`):

```
baseline ok
20260428001138 create_storage_buckets ok
20260428001207 initial_schema ok
20260428001610 grant_service_role_access ok
20260428014010 grant_anon_read_access ok
20260428214101 add_panels_table_and_bubble_fk ok
... (43 more, all ok)
20261007025604 characters_full_name ok
20261007071313 bubbles_fill_color ok
replay complete: 49 files
catalog: 566 rows -> replay.json
```

No file errored. The 49 file versions and names match production's `schema_migrations` one to one (none missing on either side).

## Differences before the fix

Production 573 rows, replay 566 rows, 109 differences (`532-replay/diff-before-fix.txt` has every row with both values).

| category | n | what | class | evidence |
|---|---|---|---|---|
| bucket | 5 changed | `comic-pages`, `comic-audio`, `comic-ocr-crops`, `comic-pages-raw`, `comic-voice-clips`: production has `file_size_limit` and `allowed_mime_types` (e.g. comic-pages `10485760`, `image/webp,image/jpeg`); the replay has null | apply-only, `20260428001138_create_storage_buckets` | recorded: `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)`; file: `insert into storage.buckets (id, name, public)` |
| bucket | 1 prod-only | `face-exemplars` (public, 5242880, image/jpeg,image/png) | apply-only, `20260506210526_face_exemplar_embeddings` | recorded: `VALUES ('face-exemplars', 'face-exemplars', true, 5242880, ARRAY['image/jpeg', 'image/png'])`; the file ends at `GRANT EXECUTE ON FUNCTION match_face_exemplars TO service_role;` |
| bucket | 1 prod-only | `bb-restyle` (public, no limits), created `2026-08-14 06:07:07`, 10 objects | hand-made | `grepstmts.mjs 'bb-restyle'` returns nothing in any recorded statement or file |
| policy | 2 prod-only | `storage.objects` "public read comic-pages", "public read comic-audio" | apply-only, `create_storage_buckets` | recorded: `create policy "public read comic-pages" on storage.objects for select using (bucket_id = 'comic-pages');` (same for comic-audio) |
| policy | 4 prod-only | `storage.objects` "public read face exemplars", "service role upload/update/delete face exemplars" | apply-only, `face_exemplar_embeddings` | recorded: `CREATE POLICY "public read face exemplars" ON storage.objects FOR SELECT TO public USING (bucket_id = 'face-exemplars');` and three `TO service_role` |
| index | 6 prod-only | `bubbles_page`, `bubbles_legacy`, `audio_timestamps_issue`, `aliases_lookup`, `casting_tasks_pending`, `pipeline_runs_issue` | apply-only, `20260428001207_initial_schema` | recorded: `create index bubbles_page on bubbles(book_id, issue_id, page_number, sort_order);` etc.; the file has no `create index` |
| index | 2 prod-only | `panels_page_idx`, `bubbles_panel_idx` | apply-only, `20260428214101_add_panels_table_and_bubble_fk` | recorded: `CREATE INDEX panels_page_idx ON panels(...)`, `CREATE INDEX bubbles_panel_idx ON bubbles(panel_id);` |
| constraint + index | 2 prod-only, 2 replay-only, plus 1 each way on the unique index | panels FK and unique are named `panels_book_issue_fkey` / `panels_panel_id_unique` on production and `panels_book_id_issue_id_fkey` / `panels_book_id_issue_id_panel_id_key` on the replay; definitions identical | apply-only, `add_panels_table_and_bubble_fk` | recorded: `CONSTRAINT panels_panel_id_unique UNIQUE (book_id, issue_id, panel_id), CONSTRAINT panels_book_issue_fkey FOREIGN KEY ...`; the file uses unnamed `foreign key (...)`, `unique (...)` |
| comment | 1 changed | `panels.foreground_polygons`: production says "Populated by extract-foreground-masks ingest step."; the file says "Populated by extract-foreground-masks + backfill-foreground-polygons." | apply-only, `20260501202530_panels_foreground_polygons` | the recorded statement holds the production text; the file was edited after the apply |
| function + function_grant | 1 + 4 prod-only | `public.rls_auto_enable()` (event_trigger, security definer, `search_path=pg_catalog`), EXECUTE to PUBLIC/anon/authenticated/service_role, and its event trigger `ensure_rls` on `ddl_command_end` for `CREATE TABLE, CREATE TABLE AS, SELECT INTO`, owner `postgres` | hand-made (the shape matches Supabase's dashboard "auto-enable RLS" option; that is my reading, not checked) | `grepstmts.mjs 'rls_auto_enable\|event trigger'` returns nothing |
| table | 1 changed | `book_parts`: RLS on in production, off in the replay | hand-made, or set by `ensure_rls` when the table was created | `grepstmts.mjs 'book_parts.*(row level\|rls)'` returns nothing; `20260504004050_book_parts` recorded = file apart from a comment |
| default_acl | 6 changed, 3 replay-only | production's `postgres` default privileges in `public`: tables `anon/authenticated/service_role = Dxtm`, sequences `= w`, functions none. Replay (stock): all | hand-made (project setting) | no recorded statement holds `default privileges`; the only hits are comments in `20261005000216` and `20261006180624` ("The project's default privileges give these roles nothing on a table") |
| table_grant | 55 changed | the stock defaults give anon/authenticated SELECT/INSERT/UPDATE/DELETE on every table, and SELECT/USAGE on `aliases_id_seq`/`pages_id_seq`, that production does not grant. Examples: `bubbles to authenticated` production `MAINTAIN,REFERENCES,TRIGGER,TRUNCATE`, replay adds `DELETE,INSERT,SELECT,UPDATE`; `llm_calls to service_role` production `INSERT,SELECT,...`, replay adds `DELETE,UPDATE` | consequence of the default_acl row (hand-made) | the files grant only what production has, e.g. `20260929021030_llm_calls.sql`: `grant select, insert on public.llm_calls to service_role;` |
| function_grant | 11 replay-only | EXECUTE to anon/authenticated (and service_role) on `match_face_exemplars`, `panel_box_usable`, `remap_panel_face_boxes`, `remap_panel_foreground_polygons` | consequence of the default_acl row (hand-made) | production `proacl`: `match_face_exemplars {=X,postgres=X,service_role=X}`; the other three null (PUBLIC + owner) |

What that means for a preview branch, assuming it starts from stock: the face-exemplars bucket and its four policies are missing, five buckets accept any size and MIME type, eight indexes are missing, and anon and authenticated hold table DML grants that production refuses. A PR whose code depends on a production grant being absent, or on the face-exemplars bucket existing, can pass its preview check on a database that behaves differently. One gap is hidden by the stock defaults: the recorded `add_panels_table_and_bubble_fk` also ran `GRANT SELECT ON panels TO authenticated`, which the file lacks. On a stock replay that grant arrives through the default privileges anyway. Under production's defaults it would be missing. The fix keeps it, because it only revokes what production lacks.

Where a function body hash differed: none did. The only function difference is `rls_auto_enable()`, which is absent from the replay.

## Checks and gates

**Check 1**, the replay runs end to end from an empty data dir: see the replay log above.

**Check 2**, `catalog.sql` run twice on production returns identical rows. I ran the file unchanged twice through `execute_sql`, extracted each result with `extract.mjs`, and compared (`532-replay/check2-determinism.txt`):
```
A=prod.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
B=prod-run2.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
differences: 0
```
`cmp prod.json prod-run2.json` → byte-identical. The raw MCP outputs are kept in `532-replay/raw/`.

**Check 3**, the diff script run on the production JSON against itself (`check3-self-diff.txt`):
```
A=prod.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
B=prod.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
differences: 0
```

**Gate 2**, the fix applied after the 49 files and the catalog rerun: `node replay.mjs --fix ../532-fix.sql` → `fix ../532-fix.sql ok`, `catalog: 573 rows` (`diff-after-fix.txt`):
```
A=prod.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
B=replay-fixed.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
differences: 0
```
No class (c) or (d) items remain.

**Idempotency**, the fix applied twice with the catalog read between passes: `node replay.mjs --fix ../532-fix.sql --twice` (`check-idempotent.txt`):
```
fix pass 1 ../532-fix.sql ok
fix pass 2 ../532-fix.sql ok
A=replay-fixed-pass1.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
B=replay-fixed-pass2.json rows=573 md5=612b5dd7333c870cd78724d10f306a68
differences: 0
```
Pass 2 ran on a database whose compared catalog equals production's, and it changed nothing there. That is the evidence for "changes nothing on production". It is a proxy: the fix never ran on production.

## What the fix covers

`/tmp/comic-reader-briefs/532-fix.sql`, 7 sections, each guarded:

1. Bucket upsert for the five limits, `face-exemplars` and `bb-restyle`. It uses `on conflict (id) do update ... where ... is distinct from ...`, so on production it updates zero rows.
2. The six `storage.objects` policies, each inside `if not exists (select from pg_policies ...)`.
3. The eight indexes, `create index if not exists`, written from production's `pg_get_indexdef`.
4. A rename of the two panels constraints to production's names, run only when the default name exists and the production name does not.
5. `comment on column panels.foreground_polygons` with production's text, which rewrites the same text on production.
6. `rls_auto_enable()` (production's `pg_get_functiondef` text verbatim, created only if `to_regprocedure` is null) plus its EXECUTE grants, the `ensure_rls` event trigger if absent, and `alter table book_parts enable row level security`.
7. `alter default privileges for role postgres in schema public revoke ...` for tables, sequences and functions. After those come 66 per-object `revoke` statements generated from the diff by `gen-grant-fix.mjs`. Revoking a privilege a role does not hold is a no-op.

## What it leaves, and calls for the lead

- **`bb-restyle` is in the fix because the brief puts class (b) in.** It is a hand-made public bucket from 2026-08-14 with 10 objects, and no code reference was checked. If it is a scratch bucket, the better move is to drop it from section 1 and decide separately whether production keeps it. That is a prod call.
- **The `ensure_rls` event trigger and the default-privilege revokes change how later migrations behave on a preview branch.** New tables get RLS automatically and no DML grants, which is how production behaves. That is the goal, but it is a behaviour change for preview branches worth naming in the O-item.
- **The fix does not edit the four old files.** The alternative is to rewrite those files to hold what production ran. Supabase replays files by version, and production's `schema_migrations` already holds those versions, so editing them would change nothing on production. Whether that is preferable to one new migration is the lead's call.

## What I could not verify

- **A Supabase preview branch was not used** (paid, refused). Two things are assumptions: that a preview branch starts from stock `postgres` default privileges, and that the brief's stock-defaults premise holds. If a preview branch starts with production's stricter defaults instead, the 55 table_grant, 11 function_grant and 9 default_acl rows would not appear there, and section 7 of the fix would be a no-op on it.
- **The replay ran as superuser.** On a real preview branch, migrations run as `postgres`, which is not a superuser on Supabase. Whether `postgres` there may create policies on `storage.objects`, update `storage.buckets` and create an event trigger is unverified. Production's history suggests yes: the recorded `create_storage_buckets` created storage policies, and `ensure_rls` is owned by `postgres`.
- **Outside the compared categories, by design or not checked:** column order (`attnum`), schema-level grants, publications, event triggers other than `ensure_rls`, the `storage` stub's own shape, extension versions (vector 0.8.0 vs 0.8.1, pgcrypto 1.3 vs 1.4: harness, not compared), and the rest of the `storage.buckets` columns.
- **Grants are read with `aclexplode` on the ACL columns, not `information_schema.role_*_grants`** as the brief named. It returns the same data without the reading role's membership filter. `current_user` on the MCP was `postgres`.
- **The catalog query I sent to production was pasted, not piped.** Production's rows matched the replay's row for row on 481 of the 566 replay rows before the fix and on all 573 after it, so the two runs used the same SQL in effect.

## Files

- `/tmp/comic-reader-briefs/532-fix.sql`: the draft fix
- `/tmp/comic-reader-briefs/532-replay/replay.mjs`: the replay (`--fix <file> [--twice]`)
- `/tmp/comic-reader-briefs/532-replay/catalog.sql`: the shared catalog query
- `/tmp/comic-reader-briefs/532-replay/diff.mjs`, `extract.mjs`, `gen-grant-fix.mjs`, `grepstmts.mjs`: the diff, MCP-result extraction, grant generator, and statement search
- `/tmp/comic-reader-briefs/532-replay/prod.json`, `prod-run2.json`, `replay.json`, `replay-fixed*.json`, `prod-schema-migrations.json`, `recorded/*.sql` (production's recorded statements, one file per migration), `raw/`: the data
- `/tmp/comic-reader-briefs/532-replay/diff-before-fix.txt`, `diff-after-fix.txt`, `check2-determinism.txt`, `check3-self-diff.txt`, `check-idempotent.txt`, `replay.log`: the outputs quoted above
