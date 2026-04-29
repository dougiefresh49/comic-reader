"use client";
import type { ComponentType } from "react";
import {
  CameraPanHorizontalDemo,
  CameraPullBackDemo,
  CameraPushInFastDemo,
  CameraPushInSlowDemo,
  PanelShakeHardDemo,
  PanelShakeSubtleDemo,
} from "./CameraEffects";
import { ImpactLinesRadial } from "./ImpactLinesRadial";
import { LensFlareCool, LensFlareWarm } from "./LensFlare";
import {
  EmbersRising,
  LeavesDrifting,
  RainFalling,
  SnowFalling,
} from "./Particles";
import { RimLightingGlow } from "./RimLightingGlow";
import {
  EnergyPortalBlueShader,
  EnergyPortalGreenShader,
  EnergyPortalRedShader,
  FireFlickerShader,
  SmokeBillowShader,
  SmokeDriftShader,
} from "./Shaders";
import { SpeedLinesDiagonal, SpeedLinesHorizontal } from "./SpeedLines";
import type { EffectProps } from "./types";

/**
 * Effect tag → React component, runtime registry.
 *
 * Camera transforms (push_in_*, pan_*, shake_*, pull_back) are
 * deliberately ABSENT from this map — they're applied by
 * PanelViewFrame via a CSS keyframe class on the page-layer wrapper,
 * not as overlays. Including them here would render the cyan
 * preview-only marker boxes on top of the page in the live reader.
 *
 * Use EFFECTS_PREVIEW (below) for the /admin/effects-preview gallery
 * which needs visible demos for every tag.
 */
export const EFFECTS: Record<string, ComponentType<EffectProps>> = {
  rim_lighting_glow: RimLightingGlow,
  lens_flare_warm: LensFlareWarm,
  lens_flare_cool: LensFlareCool,
  speed_lines_horizontal: SpeedLinesHorizontal,
  speed_lines_diagonal: SpeedLinesDiagonal,
  impact_lines_radial: ImpactLinesRadial,
  smoke_drift: SmokeDriftShader,
  smoke_billow: SmokeBillowShader,
  fire_flicker: FireFlickerShader,
  energy_portal_blue: EnergyPortalBlueShader,
  energy_portal_red: EnergyPortalRedShader,
  energy_portal_green: EnergyPortalGreenShader,
  embers_rising: EmbersRising,
  rain_falling: RainFalling,
  snow_falling: SnowFalling,
  leaves_drifting: LeavesDrifting,
};

export function getEffect(tag: string): ComponentType<EffectProps> | undefined {
  return EFFECTS[tag];
}

/**
 * Preview-only registry. Adds camera-effect demo components on top of
 * the runtime EFFECTS so the gallery has something to show for those
 * tags too.
 */
export const EFFECTS_PREVIEW: Record<string, ComponentType<EffectProps>> = {
  ...EFFECTS,
  camera_push_in_slow: CameraPushInSlowDemo,
  camera_push_in_fast: CameraPushInFastDemo,
  camera_pull_back: CameraPullBackDemo,
  camera_pan_horizontal: CameraPanHorizontalDemo,
  panel_shake_subtle: PanelShakeSubtleDemo,
  panel_shake_hard: PanelShakeHardDemo,
};

export function getPreviewEffect(
  tag: string,
): ComponentType<EffectProps> | undefined {
  return EFFECTS_PREVIEW[tag];
}
