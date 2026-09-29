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

/** Flatten tokens into one letter stream, remembering each letter's token. */
function letterStream(tokens: string[]): { chars: string; owner: number[] } {
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

/**
 * Levenshtein alignment of two letter streams. Returns the `(i, j)` index
 * pairs where the aligned letters are equal; substitutions, insertions and
 * deletions are not matches.
 */
function matchedLetters(a: string, b: string): [number, number][] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const d = new Int32Array((n + 1) * width);
  for (let i = 0; i <= n; i++) d[i * width] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * width + j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const del = d[(i - 1) * width + j]! + 1;
      const ins = d[i * width + j - 1]! + 1;
      d[i * width + j] = Math.min(sub, del, ins);
    }
  }

  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = d[i * width + j]!;
    const diag = d[(i - 1) * width + j - 1]!;
    if (a[i - 1] === b[j - 1] && here === diag) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (here === diag + 1) {
      i--;
      j--;
    } else if (here === d[(i - 1) * width + j]! + 1) {
      i--;
    } else {
      j--;
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
  for (const [ti, gi] of matchedLetters(timing.chars, lettered.chars)) {
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
