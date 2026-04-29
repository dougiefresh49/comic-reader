"use client";
import type { ComponentType } from "react";
import { ImpactLinesRadial } from "./ImpactLinesRadial";
import { LensFlareCool, LensFlareWarm } from "./LensFlare";
import { RimLightingGlow } from "./RimLightingGlow";
import { SpeedLinesDiagonal, SpeedLinesHorizontal } from "./SpeedLines";
import type { EffectProps } from "./types";

/**
 * Effect tag → React component. Tags not present here are silently
 * dropped at render time (see PanelEffectsOverlay). When a new tag is
 * added to EFFECT_TAGS, register the component here.
 *
 * v1 ships the CSS-only and SVG-overlay effects. Particle-based
 * (smoke/fire/rain/snow/embers/leaves) and canvas energy portals are
 * deferred to v2; the unmapped tags simply render nothing for now.
 */
export const EFFECTS: Record<string, ComponentType<EffectProps>> = {
  rim_lighting_glow: RimLightingGlow,
  lens_flare_warm: LensFlareWarm,
  lens_flare_cool: LensFlareCool,
  speed_lines_horizontal: SpeedLinesHorizontal,
  speed_lines_diagonal: SpeedLinesDiagonal,
  impact_lines_radial: ImpactLinesRadial,
};

export function getEffect(tag: string): ComponentType<EffectProps> | undefined {
  return EFFECTS[tag];
}
