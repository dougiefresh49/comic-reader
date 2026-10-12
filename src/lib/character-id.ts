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
 * made of each name, "TMNT MMPR" -> "tmnt-mmpr". Only for re-deriving an
 * existing row's id; a new row's id comes from `newRowId`, since this rule
 * deletes a separator such as "/" rather than dashing it (#869). It differs
 * from `slugify` in one place: like SQL's `btrim`, it trims spaces only, so a
 * name that starts or ends with a tab or newline keeps it and gets a leading
 * or trailing "-".
 */
export function franchiseSlug(name: string): string {
  return name
    .replace(/^ +| +$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * The id a new `series` or `franchises` row gets from its name (#869). Each
 * apostrophe and period goes ("Children's" -> "childrens", "Dr. Who" ->
 * "dr-who"), every other run of characters that are not a-z or 0-9 becomes one
 * "-", and the ends lose theirs: "Batman/Teenage Mutant Ninja Turtles" ->
 * "batman-teenage-mutant-ninja-turtles". A plain name gets what
 * `franchiseSlug` gives it, "TMNT MMPR" -> "tmnt-mmpr".
 */
export function newRowId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
