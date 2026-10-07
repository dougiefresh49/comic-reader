# Issue #532: preview branch vs production vs PGlite replay

[#532](https://github.com/dougiefresh49/comic-reader/issues/532) "A fresh replay of supabase/migrations may not build production's schema". This compares PR #617's preview branch (Supabase project `tgqfdbutgjafqzjsqnlh`, which has applied all 50 files including `20261007201253_replay_parity.sql`) with production and with the PGlite replay. Every read was a SELECT, and nothing was written to any Supabase project.

## Verdict

The branch differs from production in **11 rows**: `bb-restyle`, left out on purpose, and 10 grant rows. All 10 grant rows have one root cause. **The replay's stock default privileges assumption was wrong for a preview branch.** The branch starts with default privileges that are close to production's and stricter on sequences. So three grants production holds never reach the branch: two that early migrations ran on production but their files lack, which stock defaults had masked in PGlite, and one hand-made sequence default. Every statement in `replay_parity` took effect. The gap is three statements it does not contain.

The harness backs this up. PGlite rerun with the branch's default privileges as its baseline reproduces the branch exactly: 0 differences, same md5 `e5c396a9…` over 563 rows. A four-statement follow-up draft then brings that replay to production minus `bb-restyle` (572 rows, md5 `3ff98aa0…`, the same as the stock replay's).

## Runs

| side | rows | md5 | source |
|---|---|---|---|
| production | 573 | `612b5dd7333c870cd78724d10f306a68` | `prod.json` (earlier run) |
| branch | 563 | `e5c396a9280a1ca942c736c0f2cf51f3` | `catalog.sql` unchanged via `execute_sql` on `tgqfdbutgjafqzjsqnlh` → `raw/branch-catalog.txt` → `branch.json` |
| replay, 50 files, stock baseline | 572 | `3ff98aa02ae678a665be3a83fb13b6f5` | `node replay.mjs` (no `--fix`), `replay-50.log`: `20261007201253 replay_parity ok`, `replay complete: 50 files` |
| replay, 50 files, branch baseline | 563 | `e5c396a9280a1ca942c736c0f2cf51f3` | `node replay.mjs --baseline branch --out replay-branchbaseline.json` |

The brief's numbers match these: branch 563 / `e5c396a9…`, replay 572 / `3ff98aa0…`.

## Branch vs production: 11 rows (`diff-branch-vs-prod.txt`)

A is the branch and B is production.

| # | category | key | branch | production | attribution |
|---|---|---|---|---|---|
| 1 | bucket | `bb-restyle` | absent | `public=true file_size_limit=null allowed_mime_types=null` | **Branch baseline (by decision).** It is hand-made on production and was left out of `replay_parity` on purpose; the file header says "The hand-made bb-restyle bucket is left out on purpose". Branch `storage.buckets` returns six rows: comic-pages, comic-audio, comic-ocr-crops, comic-pages-raw, comic-voice-clips, face-exemplars. |
| 2-4 | default_acl | `postgres S to anon` / `to authenticated` / `to service_role` | absent | `UPDATE` | **Branch baseline.** Branch `pg_default_acl`: `postgres S public {postgres=rwU/postgres}`. Production: `postgres S public {postgres=rwU/postgres,anon=w/postgres,authenticated=w/postgres,service_role=w/postgres}`. `replay_parity` line 145 only revokes `select, usage on sequences`, so it never removed `w`; the branch never had it. |
| 5-6 | table_grant | `public.aliases_id_seq to anon` / `to authenticated` | absent | `UPDATE` | **Branch baseline.** This follows from rows 2-4: the sequences were created under the branch's sequence defaults. Branch `relacl` for both is `{postgres=rwU/postgres}`. |
| 7-8 | table_grant | `public.pages_id_seq to anon` / `to authenticated` | absent | `UPDATE` | Same as rows 5-6. |
| 9 | table_grant | `public.aliases_id_seq to service_role` | absent | `SELECT,UPDATE,USAGE` | **Not in `replay_parity`.** It is apply-only in `20260428001610_grant_service_role_access`. The recorded statement holds `grant all on all sequences in schema public to service_role;`, and the file holds only per-table `grant select, insert, update, delete on public.<t> to service_role` lines. My first comparison missed it because PGlite's stock defaults gave `service_role` this grant anyway. |
| 10 | table_grant | `public.pages_id_seq to service_role` | absent | `SELECT,UPDATE,USAGE` | Same as row 9. |
| 11 | table_grant | `public.panels to authenticated` | `MAINTAIN,REFERENCES,TRIGGER,TRUNCATE` | `MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE` | **Not in `replay_parity`.** It is apply-only in `20260428214101_add_panels_table_and_bubble_fk`; the recorded statement holds `GRANT SELECT ON panels TO authenticated;` and the file does not. The stock defaults masked it in PGlite, and my first report wrongly said the fix kept it. Branch `relacl` for panels: `{postgres=arwdDxtm/postgres,anon=rDxtm/postgres,authenticated=Dxtm/postgres,service_role=arwdDxtm/postgres}`. |

**Effect of rows 9-10, reasoned and not run:** without `USAGE` or `UPDATE` on `pages_id_seq` and `aliases_id_seq`, a `service_role` insert into `pages` or `aliases` that relies on the serial default should fail with "permission denied for sequence" on the branch. The same insert works on production. This was not exercised, because it would be a write.

## Branch vs PGlite replay, stock baseline: 10 rows (`diff-branch-vs-replay.txt`)

These are rows 2-11 above, identical keys, with the replay holding the production value in every case. The replay has the `UPDATE` default and sequence grants, `service_role` on both sequences, and authenticated `SELECT` on panels.

- **Attribution for all 10: harness.** The PGlite baseline granted the stock `postgres` default privileges (`grant all on tables|sequences|functions to anon, authenticated, service_role`), and the branch did not start from stock.
- **The branch's baseline, read from `pg_default_acl`, is not the stock set:**
  - `postgres r public {postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}`, the same as production;
  - `postgres f public {postgres=X/postgres}`, the same as production;
  - `postgres S public {postgres=rwU/postgres}`, stricter than production.
- **That is the baseline, not `replay_parity`:** `replay_parity` revokes only select/insert/update/delete on tables, select/usage on sequences and execute on functions. It cannot produce a missing `w` on sequences or a table row that never had `arwd`. The branch's `supabase_admin` rows are stock, and they match production's.
- **Harness confirmation:** with those three branch `postgres` defaults as the PGlite baseline (`--baseline branch`), the replay matches the branch exactly (`diff-branch-vs-replay-branchbaseline.txt`):
  ```
  A=branch.json rows=563 md5=e5c396a9280a1ca942c736c0f2cf51f3
  B=replay-branchbaseline.json rows=563 md5=e5c396a9280a1ca942c736c0f2cf51f3
  differences: 0
  ```
  So PG18 against PG17.11 and the storage stub add no rows. The only harness gap was the default-privilege assumption.

## Statements in `replay_parity` that did not take effect

None found. Every bucket, policy, index, constraint name, comment, the `rls_auto_enable()` function and RLS on `book_parts` match production on the branch. Branch `pg_event_trigger` holds `ensure_rls fn=rls_auto_enable owner=postgres`, so the event trigger was created as `postgres`, not a superuser. Branch `storage.buckets` holds face-exemplars, and the five buckets have their limits; no bucket row differs. The policies on `storage.objects` were created too, since no policy row differs. Branch `schema_migrations`: `max(version) = 20261007201253`, 50 rows.

## Not compared by `catalog.sql` but read on the branch

Extension-owned objects are excluded on all three sides, so these produce no rows. Branch `pg_extension`: vector **0.8.2** in public (production 0.8.0, PGlite 0.8.1), and **pg_net 0.20.4** in extensions, which production lacks. Also present: pgcrypto 1.3, uuid-ossp 1.1, pg_stat_statements 1.11, supabase_vault 0.3.1. Branch: Postgres 17.11 x86_64; production: 17.6 aarch64.

## Draft follow-up (not a migration; `532-replay/followup-draft.sql`)

```sql
grant select on public.panels to authenticated;
grant select, update, usage on sequence public.aliases_id_seq, public.pages_id_seq to service_role;
alter default privileges for role postgres in schema public grant update on sequences to anon, authenticated, service_role;
grant update on sequence public.aliases_id_seq, public.pages_id_seq to anon, authenticated;
```

Each statement grants only what production already holds, so it should be a no-op there. That has not been run on production. Evidence from the harness:

- On the branch baseline, after the 50 files: `node replay.mjs --baseline branch --fix followup-draft.sql --twice` gives `fix pass 1 ok`, `fix pass 2 ok`. Against production (`diff-prod-vs-branchbaseline-followup.txt`): 572 rows, md5 `3ff98aa0…`, and 1 difference, `only-A bucket bb-restyle`.
- Idempotency, pass 1 against pass 2 (`check-followup-idempotent.txt`): 0 differences.
- On the stock baseline the same file leaves the same single `bb-restyle` difference (`replay-stock-followup.json`), so it is safe whichever baseline a branch starts from.

The third and fourth statements copy a hand-made production setting, anon and authenticated `UPDATE` on sequences. That grant lets those roles call `nextval`. Whether to copy it to branches, or to treat it as a production setting to drop, is the lead's call. The first two statements restore what migrations ran on production.

## Correction to `532-report.md`

That report assumed a preview branch starts from stock default privileges. It also said the fix "keeps" authenticated `SELECT` on panels "because it only revokes what production lacks". Both are wrong for a real branch. The branch starts strict, and the panels grant and the service_role sequence grants are missing there. The rest of that report's attributions stand.

## Files

All in `/tmp/comic-reader-briefs/532-replay/`:

- `branch.json`, `raw/branch-catalog.txt`: the branch catalog
- `diff-branch-vs-prod.txt`, `diff-branch-vs-replay.txt`, `diff-branch-vs-replay-branchbaseline.txt`, `diff-prod-vs-branchbaseline-followup.txt`, `check-followup-idempotent.txt`: the diffs and checks quoted above
- `replay.mjs`: now accepts `--baseline branch` and `--out <file>`
- `replay-50.log`, `replay-branchbaseline*.json|log`: the replay runs
- `followup-draft.sql`: the draft follow-up
