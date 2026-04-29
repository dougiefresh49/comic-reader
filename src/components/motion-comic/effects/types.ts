/**
 * Effect component contract.
 *
 * Each effect tag in EFFECT_TAGS (src/lib/panel-tags.ts) maps to a React
 * component that renders inside the active panel's bbox. Effects layer
 * on top of the comic page; they receive the panel's bbox in 0..1
 * fractions of the page.
 */

export interface EffectProps {
  /** 0..1 fraction of the page — the panel rect this effect should render within. */
  bbox: { x: number; y: number; w: number; h: number };
  /** True only when this is the focused panel in panel-view mode. */
  active: boolean;
  /**
   * 0..1 progression through the panel's display window. Drives effects
   * that have a beginning/middle/end (e.g. impact_lines fading out).
   * For loop effects (rain, glow), this can be ignored.
   */
  progress: number;
  /** Honor prefers-reduced-motion: render a static representation. */
  reducedMotion: boolean;
}
