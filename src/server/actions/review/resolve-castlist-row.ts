/** Local copy of scripts/utils/registry.ts slugify. Do not import that module. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export type ResolveCastlistResult<T> =
  | { ok: true; row: T }
  | { ok: false; error: string };

/**
 * Resolve a bubble speaker (often a slug) to a castlist row.
 * Exact `character` match first, then slug-normalized match.
 * Ambiguous when two castlist rows normalize to the same key.
 */
export function resolveCastlistRow<T extends { character: string }>(
  speaker: string,
  castlistRows: T[],
): ResolveCastlistResult<T> {
  const exact = castlistRows.find((row) => row.character === speaker);
  if (exact) return { ok: true, row: exact };

  const key = slugify(speaker);
  const normalized = castlistRows.filter(
    (row) => slugify(row.character) === key,
  );
  if (normalized.length === 0) {
    return {
      ok: false,
      error: `No castlist row for speaker '${speaker}'`,
    };
  }
  if (normalized.length > 1) {
    const names = normalized.map((row) => `'${row.character}'`).join(" and ");
    return {
      ok: false,
      error: `Ambiguous castlist match for speaker '${speaker}': ${names}`,
    };
  }
  return { ok: true, row: normalized[0]! };
}
