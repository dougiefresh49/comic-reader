import type { WordTiming } from "~/components/zen-comic-reader/text-utils";
import type { Box, TextGeometry } from "~/types/text-geometry";

export type WordGeometryMatch = {
  /** One entry per timing word; `[]` when nothing lettered belongs to it. */
  boxesByTimingIndex: Box[][];
  /** Geometry words with an owner / lettered geometry words (0 when none). */
  coverage: number;
  /** Geometry words with at least one letter or digit. */
  letteredWordCount: number;
};

/** Uppercase, curly apostrophe to straight, keep only A-Z, 0-9 and `'`. */
const toLetters = (value: string): string =>
  value
    .toUpperCase()
    .replace(/’/g, "'")
    .replace(/[^A-Z0-9']/g, "");

const isLettered = (letters: string): boolean => /[A-Z0-9]/.test(letters);

type Stream = { chars: string; owner: number[] };

/** Flatten tokens into one letter stream, remembering each letter's token. */
function letterStream(tokens: string[]): Stream {
  let chars = "";
  const owner: number[] = [];
  tokens.forEach((token, index) => {
    for (const ch of token) {
      chars += ch;
      owner.push(index);
    }
  });
  return { chars, owner };
}

// Lexicographic cost packed into one exact float: fewest edits first (plain
// Levenshtein), then fewest substitutions (so `TEH` keeps two matches against
// `THE`), then fewest gap edges that fall inside a word (so a junk or
// repeated word is skipped whole, `RACT` or the `OOK` in `LOOK OOK OUT`,
// instead of lending letters to a neighbour), then fewest turns where one
// stream sits between words and the other inside one (so `TH THAT AT` gives
// "that" to `THAT`, not to the scraps around it, and a joined token beats its
// split pieces in either order). Exact for streams under 2k letters each.
const EDGE = 2 ** 13;
const EDIT = 2 ** 39;
const SUB = EDIT + 2 ** 27;

/**
 * Minimum-edit alignment of two letter streams, three-state so gap edges can
 * break ties. Returns the `(i, j)` index pairs where the aligned letters are
 * equal; substitutions, insertions and deletions are not matches.
 */
function matchedLetters(sa: Stream, sb: Stream): [number, number][] {
  const a = sa.chars;
  const b = sb.chars;
  const n = a.length;
  const m = b.length;
  // 1 when a gap edge at position p (between letters p-1 and p) splits a word.
  const edge = (s: Stream, p: number) =>
    p > 0 && p < s.owner.length && s.owner[p - 1] === s.owner[p] ? 1 : 0;
  const eA = (p: number) => edge(sa, p);
  const eB = (p: number) => edge(sb, p);
  // 1 when lattice point (i, j) is a word boundary in one stream only. Paid
  // wherever the path turns or runs diagonally, not inside a straight gap.
  const turn = (i: number, j: number) => eA(i) ^ eB(j);
  const w = m + 1;
  const size = (n + 1) * w;
  // diag: ends pairing a[i-1] with b[j-1]; gapA: ends on a[i-1] alone;
  // gapB: ends on b[j-1] alone. A gap pays its opening edge when it starts
  // and its closing edge when another state follows it.
  const diag = new Float64Array(size).fill(Infinity);
  const gapA = new Float64Array(size).fill(Infinity);
  const gapB = new Float64Array(size).fill(Infinity);
  diag[0] = 0;
  for (let i = 1; i <= n; i++) gapA[i * w] = i * EDIT;
  for (let j = 1; j <= m; j++) gapB[j] = j * EDIT;
  const cost = (i: number, j: number) => (a[i - 1] === b[j - 1] ? 0 : SUB);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const k = i * w + j;
      const up = k - w;
      const left = k - 1;
      const p = up - 1;
      diag[k] =
        Math.min(
          diag[p]!,
          gapA[p]! + EDGE * eA(i - 1),
          gapB[p]! + EDGE * eB(j - 1),
        ) +
        turn(i - 1, j - 1) +
        cost(i, j);
      gapA[k] =
        Math.min(
          gapA[up]!,
          Math.min(
            diag[up]! + EDGE * eA(i - 1),
            gapB[up]! + EDGE * (eB(j) + eA(i - 1)),
          ) + turn(i - 1, j),
        ) + EDIT;
      gapB[k] =
        Math.min(
          gapB[left]!,
          Math.min(
            diag[left]! + EDGE * eB(j - 1),
            gapA[left]! + EDGE * (eA(i) + eB(j - 1)),
          ) + turn(i, j - 1),
        ) + EDIT;
    }
  }

  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  let k = i * w + j;
  const end = Math.min(diag[k]!, gapA[k]!, gapB[k]!);
  let state = diag[k] === end ? diag : gapA[k] === end ? gapA : gapB;
  while (i > 0 || j > 0) {
    const here = state[k]!;
    if (state === diag) {
      if (a[i - 1] === b[j - 1]) pairs.push([i - 1, j - 1]);
      const prev = here - cost(i, j) - turn(i - 1, j - 1);
      i--;
      j--;
      k = i * w + j;
      state =
        diag[k] === prev
          ? diag
          : gapA[k]! + EDGE * eA(i) === prev
            ? gapA
            : gapB;
    } else if (state === gapA) {
      const prev = here - EDIT;
      i--;
      k = i * w + j;
      state =
        gapA[k] === prev
          ? gapA
          : diag[k]! + EDGE * eA(i) + turn(i, j) === prev
            ? diag
            : gapB;
    } else {
      const prev = here - EDIT;
      j--;
      k = i * w + j;
      state =
        gapB[k] === prev
          ? gapB
          : diag[k]! + EDGE * eB(j) + turn(i, j) === prev
            ? diag
            : gapA;
    }
  }
  return pairs;
}

/**
 * Which lettered word boxes light for each TTS timing word (#62). Both sides
 * become one letter stream, a Levenshtein alignment pairs the letters, and
 * each geometry word goes to the timing word it shares the most matched
 * letters with, if at least half its letters matched. That one mechanism
 * covers casing, TTS punctuation, line-break hyphen splits, merged rows and
 * small OCR errors. Pure: computed at read time, never stored.
 */
export function alignTimingsToGeometry(
  words: WordTiming[],
  geometry: TextGeometry,
): WordGeometryMatch {
  const boxesByTimingIndex: Box[][] = words.map(() => []);

  const geoWords = geometry.lines
    .flatMap((line) => line.words)
    .map((word) => ({ box: word.box, letters: toLetters(word.t) }))
    .filter((word) => isLettered(word.letters));
  if (!geoWords.length) {
    return { boxesByTimingIndex, coverage: 0, letteredWordCount: 0 };
  }

  const timing = letterStream(words.map((w) => toLetters(w.word)));
  const lettered = letterStream(geoWords.map((w) => w.letters));

  // shared[g] maps timing index -> matched letters for geometry word g.
  const shared = geoWords.map(() => new Map<number, number>());
  for (const [ti, gi] of matchedLetters(timing, lettered)) {
    const counts = shared[lettered.owner[gi]!]!;
    const t = timing.owner[ti]!;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  let owned = 0;
  geoWords.forEach((word, g) => {
    let best = -1;
    let bestCount = 0;
    for (const [t, count] of shared[g]!) {
      if (count > bestCount || (count === bestCount && t < best)) {
        best = t;
        bestCount = count;
      }
    }
    if (best < 0 || bestCount * 2 < word.letters.length) return;
    owned++;
    const boxes = boxesByTimingIndex[best]!;
    // A line without word granularity repeats its box on every word.
    if (!boxes.some((box) => box.every((v, k) => v === word.box[k]))) {
      boxes.push(word.box);
    }
  });

  return {
    boxesByTimingIndex,
    coverage: owned / geoWords.length,
    letteredWordCount: geoWords.length,
  };
}
