/**
 * Groups the faces lookahead could not name (#348), so the characters stop
 * can ask for one name per group instead of one per face. Pure: embeddings
 * in, group numbers out, no DB access and no model call.
 */

// Cosine similarity on gemini-embedding-2 face crops. Prod exemplar pairs
// (2026-10-02, 5,005 pairs): different characters average 0.74 and 1% reach
// 0.87; same character averages 0.82. At 0.88 about 70% of pairs that reach it
// are the same character, and complete linkage asks it of every pair in a group.
export const FACE_GROUP_MIN_SIMILARITY = 0.88;

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `face embeddings differ in length: ${a.length} and ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * One group number per face, 1-based, numbered in the order each group's
 * first face appears in the input. Complete linkage: two groups merge only
 * when every pair of faces across them reaches `minSimilarity`, so a chain of
 * look-alikes cannot pull two different characters together. A face with no
 * embedding (null) is a group of its own.
 */
export function groupFaces(
  embeddings: ReadonlyArray<readonly number[] | null>,
  minSimilarity: number = FACE_GROUP_MIN_SIMILARITY,
): number[] {
  const n = embeddings.length;
  // sim[i][j]: the lowest similarity between any face of group i and group j.
  const sim: number[][] = embeddings.map((a, i) =>
    embeddings.map((b, j) =>
      i === j || a === null || b === null ? -Infinity : cosine(a, b),
    ),
  );
  const root = embeddings.map((_, i) => i);
  const active = new Set(root);

  for (;;) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (const i of active) {
      for (const j of active) {
        if (j <= i) continue;
        if (sim[i]![j]! > best) {
          best = sim[i]![j]!;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi === -1 || best < minSimilarity) break;

    active.delete(bj);
    for (let k = 0; k < n; k++) if (root[k] === bj) root[k] = bi;
    for (const k of active) {
      if (k === bi) continue;
      const merged = Math.min(sim[bi]![k]!, sim[bj]![k]!);
      sim[bi]![k] = merged;
      sim[k]![bi] = merged;
    }
  }

  const numberOf = new Map<number, number>();
  return root.map((r) => {
    let g = numberOf.get(r);
    if (g === undefined) {
      g = numberOf.size + 1;
      numberOf.set(r, g);
    }
    return g;
  });
}
