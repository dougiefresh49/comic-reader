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
 * Group by normalized key. Differing voice_id values in the group are a
 * collision (error naming every row). Same voice_id: exact character match
 * first, else the first row in the group.
 */
export function resolveCastlistRow<
  T extends { character: string; voice_id: string | null },
>(speaker: string, castlistRows: T[]): ResolveCastlistResult<T> {
  const key = slugify(speaker);
  const group = castlistRows.filter((row) => slugify(row.character) === key);

  if (group.length === 0) {
    return {
      ok: false,
      error: `No castlist row for speaker '${speaker}'`,
    };
  }

  const voiceIds = new Set(group.map((row) => row.voice_id));
  if (voiceIds.size > 1) {
    const names = group.map((row) => `'${row.character}'`).join(" and ");
    return {
      ok: false,
      error: `Ambiguous castlist match for speaker '${speaker}': ${names}`,
    };
  }

  const exact = group.find((row) => row.character === speaker);
  if (exact) return { ok: true, row: exact };
  return { ok: true, row: group[0]! };
}
