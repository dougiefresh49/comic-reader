// Search production's recorded migration statements and the repo files for a regex.
// Usage: node grepstmts.mjs <regex>
import { readFileSync, readdirSync } from 'node:fs';
const MIG = '/Users/dougiefresh49/.t3/worktrees/comic-reader/issue-532-migration-replay/supabase/migrations';
const re = new RegExp(process.argv[2], 'i');
const rows = JSON.parse(readFileSync(new URL('./prod-schema-migrations.json', import.meta.url)));
for (const r of rows) (r.statements || []).forEach((s, i) => { s.split('\n').forEach(line => { if (re.test(line)) console.log(`recorded ${r.version}_${r.name} stmt#${i}: ${line.trim().slice(0, 220)}`); }); });
for (const f of readdirSync(MIG).sort()) readFileSync(`${MIG}/${f}`, 'utf8').split('\n').forEach((line, n) => { if (re.test(line)) console.log(`file     ${f}:${n + 1}: ${line.trim().slice(0, 220)}`); });
