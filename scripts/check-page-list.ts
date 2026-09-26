/**
 * Read-only acceptance seam for page list / WebP presence.
 *
 * Usage: pnpm tsx --env-file=.env scripts/check-page-list.ts <bookId> <issueId>
 */
import { createClient } from "@supabase/supabase-js";
import { FatalError } from "workflow";
import { queryPageList } from "~/workflows/steps/shared";

const bookId = process.argv[2];
const issueId = process.argv[3];

if (!bookId || !issueId) {
  console.error(
    "Usage: pnpm tsx --env-file=.env scripts/check-page-list.ts <bookId> <issueId>",
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

try {
  const pages = await queryPageList(supabase, bookId, issueId);
  if (pages.length === 0) {
    console.log(`(no pages rows for ${bookId}/${issueId})`);
    process.exit(0);
  }
  for (const page of pages) {
    console.log(`page ${page.pageNumber}: ${page.width}×${page.height}`);
  }
  console.log(`total: ${pages.length}`);
} catch (err) {
  if (err instanceof FatalError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
