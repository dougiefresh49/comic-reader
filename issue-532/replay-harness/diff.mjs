// Diff two catalog.sql outputs by (category, key).
// Usage: node diff.mjs <prod.json> <replay.json>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [, , a, b] = process.argv;
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const A = load(a), B = load(b);
const digest = rows => createHash('md5').update(rows.map(r => `${r.c}\t${r.k}\t${r.d}`).join('\n')).digest('hex');
const idx = rows => { const m = new Map(); for (const r of rows) { const key = `${r.c}\u0000${r.k}`; if (m.has(key)) throw new Error(`duplicate key ${r.c} ${r.k}`); m.set(key, r.d); } return m; };
const MA = idx(A), MB = idx(B);
console.log(`A=${a} rows=${A.length} md5=${digest(A)}`);
console.log(`B=${b} rows=${B.length} md5=${digest(B)}`);
const out = [];
for (const [key, d] of MA) {
  const [c, k] = key.split('\u0000');
  if (!MB.has(key)) out.push({ c, k, kind: 'only-A', a: d });
  else if (MB.get(key) !== d) out.push({ c, k, kind: 'changed', a: d, b: MB.get(key) });
}
for (const [key, d] of MB) {
  const [c, k] = key.split('\u0000');
  if (!MA.has(key)) out.push({ c, k, kind: 'only-B', b: d });
}
out.sort((x, y) => (x.c + x.k < y.c + y.k ? -1 : 1));
for (const o of out) {
  console.log(`${o.kind.padEnd(7)} ${o.c.padEnd(14)} ${o.k}`);
  if (o.a !== undefined) console.log(`        A: ${o.a}`);
  if (o.b !== undefined) console.log(`        B: ${o.b}`);
}
console.log(`differences: ${out.length}`);
