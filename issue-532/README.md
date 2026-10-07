# Issue #532: migration replay vs production

Evidence and the throwaway harness behind https://github.com/dougiefresh49/comic-reader/issues/532 and PR #617.

- `replay-report.md`: the first comparison (PGlite replay on an assumed stock baseline; the stock-defaults assumption was later found wrong, see `branch-diff.md`).
- `branch-diff.md`: the real preview branch vs production, which settled the baseline.
- `prod-catalog-2026-10-07.json`: production's catalog rows from `replay-harness/catalog.sql`, read before `replay_parity` was applied (hash `612b5dd7333c870cd78724d10f306a68`, 573 rows; unchanged after the apply).
- `replay-harness/`: `node replay.mjs --baseline branch` replays `supabase/migrations/` into a fresh PGlite database (edit `MIG` at the top for the checkout path), then `node diff.mjs prod.json replay.json`. `catalog-md5.sql` is the one-row hash of the same query for a Supabase project.
