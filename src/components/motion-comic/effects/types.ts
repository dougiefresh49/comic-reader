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
  /** Gemini-provided position hint: anchor or sub-bbox within the panel. */
  position?: { anchor?: string; bbox?: [number, number, number, number] };
}

/**
 * Resolve effect position to a CSS rect (% of page).
 * If position has a sub-bbox, maps it relative to the panel bbox.
 * If position has an anchor, returns origin point (cx, cy) as 0..1 within the panel.
 * Falls back to the full panel bbox.
 */
export function resolveEffectRect(
  panelBbox: EffectProps["bbox"],
  position?: EffectProps["position"],
): { left: string; top: string; width: string; height: string } {
  if (position?.bbox) {
    const [rx, ry, rw, rh] = position.bbox;
    return {
      left: `${(panelBbox.x + rx * panelBbox.w) * 100}%`,
      top: `${(panelBbox.y + ry * panelBbox.h) * 100}%`,
      width: `${rw * panelBbox.w * 100}%`,
      height: `${rh * panelBbox.h * 100}%`,
    };
  }
  return {
    left: `${panelBbox.x * 100}%`,
    top: `${panelBbox.y * 100}%`,
    width: `${panelBbox.w * 100}%`,
    height: `${panelBbox.h * 100}%`,
  };
}

/**
 * Resolve anchor to a transform-origin string within the panel.
 * Returns CSS transform-origin value like "50% 50%" or "0% 100%".
 */
export function resolveAnchorOrigin(anchor?: string): string {
  switch (anchor) {
    case "top-left":
      return "0% 0%";
    case "top-center":
      return "50% 0%";
    case "top-right":
      return "100% 0%";
    case "left-center":
      return "0% 50%";
    case "center":
      return "50% 50%";
    case "right-center":
      return "100% 50%";
    case "bottom-left":
      return "0% 100%";
    case "bottom-center":
      return "50% 100%";
    case "bottom-right":
      return "100% 100%";
    default:
      return "50% 50%";
  }
}
