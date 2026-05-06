import type { PanelBoundingBox } from "~/types/panels";

export const PANEL_VIEW_TRANSITION_MS = 380;
export const PANEL_VIEW_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const PANEL_VIEW_MARGIN = 0.05;

const SPRING_STIFFNESS = 170;
const SPRING_DAMPING = 26;
const SPRING_MASS = 1;
const SPRING_REST_THRESHOLD = 0.01;
const SPRING_DT = 1 / 60;

export interface PanelTransformResult {
  scale: number;
  tx: number;
  ty: number;
}

export interface SpringState {
  tx: number;
  ty: number;
  scale: number;
  vTx: number;
  vTy: number;
  vScale: number;
}

export function createSpringState(t: PanelTransformResult): SpringState {
  return { tx: t.tx, ty: t.ty, scale: t.scale, vTx: 0, vTy: 0, vScale: 0 };
}

function springStep(current: number, target: number, velocity: number) {
  const force = -SPRING_STIFFNESS * (current - target);
  const drag = -SPRING_DAMPING * velocity;
  const accel = (force + drag) / SPRING_MASS;
  const newVelocity = velocity + accel * SPRING_DT;
  const newCurrent = current + newVelocity * SPRING_DT;
  return { value: newCurrent, velocity: newVelocity };
}

function isAtRest(current: number, target: number, velocity: number): boolean {
  return (
    Math.abs(current - target) < SPRING_REST_THRESHOLD &&
    Math.abs(velocity) < SPRING_REST_THRESHOLD
  );
}

export function stepSpring(
  state: SpringState,
  target: PanelTransformResult,
): { state: SpringState; atRest: boolean } {
  const tx = springStep(state.tx, target.tx, state.vTx);
  const ty = springStep(state.ty, target.ty, state.vTy);
  const sc = springStep(state.scale, target.scale, state.vScale);
  const atRest =
    isAtRest(tx.value, target.tx, tx.velocity) &&
    isAtRest(ty.value, target.ty, ty.velocity) &&
    isAtRest(sc.value, target.scale, sc.velocity);
  return {
    state: {
      tx: atRest ? target.tx : tx.value,
      ty: atRest ? target.ty : ty.value,
      scale: atRest ? target.scale : sc.value,
      vTx: atRest ? 0 : tx.velocity,
      vTy: atRest ? 0 : ty.velocity,
      vScale: atRest ? 0 : sc.velocity,
    },
    atRest,
  };
}

/**
 * Compute the rendered image rect inside a container using object-contain logic.
 * Returns the position and size of the image within the container.
 */
export function renderedImageRect(
  container: { w: number; h: number },
  pageNatural: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (pageNatural.w <= 0 || pageNatural.h <= 0) {
    return { x: 0, y: 0, w: container.w, h: container.h };
  }
  const imageAspect = pageNatural.w / pageNatural.h;
  const containerAspect = container.w / container.h;
  let rW: number, rH: number;
  if (imageAspect > containerAspect) {
    rW = container.w;
    rH = container.w / imageAspect;
  } else {
    rH = container.h;
    rW = container.h * imageAspect;
  }
  return {
    x: (container.w - rW) / 2,
    y: (container.h - rH) / 2,
    w: rW,
    h: rH,
  };
}

/**
 * Compute CSS transform (translate + scale, origin 0 0) so the panel bbox
 * fills the container (with margin) and its center aligns with the container center.
 *
 * `imageRect` is where the image actually renders within the container
 * (accounting for object-contain letterboxing/pillarboxing).
 */
export function panelTransform(
  panel: PanelBoundingBox,
  container: { w: number; h: number },
  imageRect: { x: number; y: number; w: number; h: number },
  margin = PANEL_VIEW_MARGIN,
): PanelTransformResult {
  const panelW = panel.w * imageRect.w;
  const panelH = panel.h * imageRect.h;
  const targetW = container.w * (1 - margin * 2);
  const targetH = container.h * (1 - margin * 2);
  const scale =
    panelW > 0 && panelH > 0 ? Math.min(targetW / panelW, targetH / panelH) : 1;

  const panelCenterX = imageRect.x + (panel.x + panel.w / 2) * imageRect.w;
  const panelCenterY = imageRect.y + (panel.y + panel.h / 2) * imageRect.h;
  const tx = container.w / 2 - panelCenterX * scale;
  const ty = container.h / 2 - panelCenterY * scale;

  return { scale, tx, ty };
}
