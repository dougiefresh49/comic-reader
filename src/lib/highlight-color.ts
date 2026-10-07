/**
 * The word-highlight colour for a bubble, from its stored fill colour (#575,
 * decisions row 365). Pure and import-free, so the reader's client code can
 * call it.
 *
 * The overlay multiplies (`mix-blend-mode: multiply`, row 364), so what a kid
 * sees over the balloon is `fill × marker` per channel at the active opacity.
 * On a white or cream balloon that is the marker itself; on a coloured one a
 * yellow marker can all but vanish (yellow over orange is orange), so another
 * colour from a fixed list is picked.
 */

/** The marker on white and cream balloons, and whenever the fill is unknown (#75, owner call O70). */
export const DEFAULT_MARKER = "#FDE047";

/** The active word's marker opacity; the blend maths below and the overlay share it. */
export const ACTIVE_OPACITY = 0.85;

/** Tried in this order; ties go to the earlier one. */
const CANDIDATES = [
  DEFAULT_MARKER, // yellow
  "#67E8F9", // cyan
  "#F9A8D4", // pink
  "#86EFAC", // green
  "#A5B4FC", // periwinkle
  "#FDBA74", // orange
] as const;

/** Black lettering must stay readable under the marker (WCAG AA). */
const MIN_CONTRAST_WITH_BLACK = 4.5;
/** A fill this light and this grey is a white or cream balloon. */
const NEAR_WHITE_LUMINANCE = 0.75;
const NEAR_WHITE_MAX_SPREAD = 40;

type Rgb = [number, number, number];

/** `#rrggbb` (either case, `#` optional) as 0-255 channels, else null. */
function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function linear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of 0-255 sRGB. */
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastWithBlack(rgb: Rgb): number {
  return (luminance(rgb) + 0.05) / 0.05;
}

/** CIE L*a*b* (D65) of 0-255 sRGB. */
function lab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map(linear) as Rgb;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) =>
    t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. */
function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** What the kid sees: the marker multiplied over the fill at the active opacity. */
function seenOver(fill: Rgb, marker: Rgb): Rgb {
  return fill.map(
    (f, i) => f * (1 - ACTIVE_OPACITY * (1 - marker[i]! / 255)),
  ) as Rgb;
}

/**
 * The marker colour for a bubble with this fill. Unknown or near-white
 * fill: `DEFAULT_MARKER`. Otherwise the candidate whose blend stands out
 * most from the fill (largest ΔE) among those that keep black lettering at
 * 4.5:1, or, when none does, the one with the most contrast with black.
 */
export function highlightColorFor(fill: string | null | undefined): string {
  const rgb = fill ? parseHex(fill) : null;
  if (!rgb) return DEFAULT_MARKER;
  const spread = Math.max(...rgb) - Math.min(...rgb);
  if (luminance(rgb) >= NEAR_WHITE_LUMINANCE && spread <= NEAR_WHITE_MAX_SPREAD)
    return DEFAULT_MARKER;

  let best: string | null = null;
  let bestDelta = -1;
  let fallback: string = DEFAULT_MARKER;
  let fallbackContrast = -1;
  for (const candidate of CANDIDATES) {
    const seen = seenOver(rgb, parseHex(candidate)!);
    const contrast = contrastWithBlack(seen);
    if (contrast > fallbackContrast) {
      fallback = candidate;
      fallbackContrast = contrast;
    }
    if (contrast < MIN_CONTRAST_WITH_BLACK) continue;
    const delta = deltaE(rgb, seen);
    if (delta > bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best ?? fallback;
}
