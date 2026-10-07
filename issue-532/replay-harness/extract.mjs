// Pull the row array out of a saved Supabase MCP execute_sql result file.
// Usage: node extract.mjs <mcp-result.txt> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src, out] = process.argv;
const outer = JSON.parse(readFileSync(src, 'utf8'));
const m = outer.result.match(/<untrusted-data-[0-9a-f-]+>\n([\s\S]*)\n<\/untrusted-data-/);
if (!m) throw new Error('no data block');
const rows = JSON.parse(m[1]);
writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} rows -> ${out}`);
