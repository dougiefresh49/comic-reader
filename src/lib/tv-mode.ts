/**
 * TV mode (#951): the reader's layout for the Samsung TV remote. The flag is
 * the `layout-tv` class on <html>, set by `TvModeFlag` after mount and read by
 * `useTvMode`. Everything here is pure so a later test can reach it.
 */

/** The class on <html> that turns TV mode on. */
export const TV_MODE_CLASS = "layout-tv";

/** sessionStorage key that `?tv=1` sets and `?tv=0` removes. */
export const TV_MODE_SESSION_KEY = "reader:tv";

/** The Tizen remote's Back key. */
export const TIZEN_BACK_KEY_CODE = 10009;

/**
 * The TV's user agent has no `Chrome/` token, so match the platform:
 * `Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) ...` (docs/tizen.md, Findings).
 */
export function isTvUserAgent(ua: string): boolean {
  return /SMART-TV|Tizen/.test(ua);
}

/**
 * Whether TV mode is on, and the session value to keep. `?tv=1` stores "1",
 * `?tv=0` clears it, and any other value leaves the stored one alone. A TV
 * user agent is on whatever the session says.
 */
export function resolveTvMode(
  ua: string,
  tvParam: string | null,
  stored: string | null,
): { on: boolean; stored: string | null } {
  const next = tvParam === "1" ? "1" : tvParam === "0" ? null : stored;
  return { on: isTvUserAgent(ua) || next === "1", stored: next };
}

/**
 * Back on the remote, or Backspace so a desktop browser can test it. The
 * caller skips Backspace inside a text field.
 */
export function isTvBackKey(e: { keyCode: number; key: string }): boolean {
  return e.keyCode === TIZEN_BACK_KEY_CODE || e.key === "Backspace";
}

/**
 * The index one step from `current` in a list of `count`, or null past
 * either end (no wrap). With nothing focused (`current` -1), a step forward
 * lands on the first item and a step back on the last.
 */
export function stepFocusIndex(
  current: number,
  count: number,
  delta: 1 | -1,
): number | null {
  if (count <= 0) return null;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  const next = current + delta;
  return next >= 0 && next < count ? next : null;
}

export interface TvBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TvDirection = "up" | "down" | "left" | "right";

/**
 * The index of the box nearest `from` in `dir`, by box centers, or null when
 * none lies that way. Distance along the direction counts once and the
 * sideways offset twice, so a card in the same row or column wins over a
 * diagonal one, however the grid wraps.
 */
export function nearestInDirection(
  from: TvBox,
  boxes: TvBox[],
  dir: TvDirection,
): number | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: number | null = null;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    const dx = b.left + b.width / 2 - cx;
    const dy = b.top + b.height / 2 - cy;
    const along =
      dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const across = dir === "left" || dir === "right" ? dy : dx;
    if (along <= 1) return;
    const score = along + 2 * Math.abs(across);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
