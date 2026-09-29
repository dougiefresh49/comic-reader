/** x, y, w, h; page-normalized (0..1, 4 decimals), top-left origin. */
export type Box = [number, number, number, number];

/**
 * Lettered word boxes for one bubble, stored as `bubbles.text_geometry`
 * (#61). Lines are in reading order; a line with no per-word granularity
 * repeats the line box on every word.
 */
export type TextGeometry = {
  engine: string;
  image: { w: number; h: number; sha: string };
  lines: { box: Box; words: { t: string; box: Box; conf: number }[] }[];
};
