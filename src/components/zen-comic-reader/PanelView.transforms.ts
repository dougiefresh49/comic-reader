import type { PanelBoundingBox } from "~/types/panels";

export const PANEL_VIEW_TRANSITION_MS = 380;
export const PANEL_VIEW_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const PANEL_VIEW_MARGIN = 0.05;

export interface PanelTransformResult {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Compute CSS transform (translate + scale, origin 0 0) so the panel bbox
 * fills the container (with margin) and its center aligns with the container center.
 */
export function panelTransform(
  panel: PanelBoundingBox,
  container: { w: number; h: number },
  page: { w: number; h: number },
  margin = PANEL_VIEW_MARGIN,
): PanelTransformResult {
  const panelW = panel.w * page.w;
  const panelH = panel.h * page.h;
  const targetW = container.w * (1 - margin * 2);
  const targetH = container.h * (1 - margin * 2);
  const scale =
    panelW > 0 && panelH > 0 ? Math.min(targetW / panelW, targetH / panelH) : 1;

  const panelCenterX = (panel.x + panel.w / 2) * page.w;
  const panelCenterY = (panel.y + panel.h / 2) * page.h;
  const tx = container.w / 2 - panelCenterX * scale;
  const ty = container.h / 2 - panelCenterY * scale;

  return { scale, tx, ty };
}
