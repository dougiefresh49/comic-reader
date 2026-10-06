/** A character name to its id: "April O'Neil" -> "april-oneil". The only copy of this rule. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * A franchise name to its `franchises.id`: what `pg_temp.slug` in the P1
 * backfill (supabase/migrations/20261005000256_casting_data_model_backfill.sql)
 * made of each name, "TMNT MMPR" -> "tmnt-mmpr". It differs from `slugify` in
 * one place: like SQL's `btrim`, it trims spaces only, so a name that starts
 * or ends with a tab or newline keeps it and gets a leading or trailing "-".
 */
export function franchiseSlug(name: string): string {
  return name
    .replace(/^ +| +$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
