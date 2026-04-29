/**
 * Canonical tag enums for panel direction.
 *
 * Both pipeline scripts (panel-director, panel-describer) and the browser
 * panel review UI need these. Living here (under src/) keeps the client
 * import path clean; scripts re-export via scripts/utils/panel-director.ts.
 */

export const EFFECT_TAGS = [
  "energy_portal_blue",
  "energy_portal_red",
  "energy_portal_green",
  "smoke_billow",
  "smoke_drift",
  "fire_flicker",
  "embers_rising",
  "impact_lines_radial",
  "speed_lines_horizontal",
  "speed_lines_diagonal",
  "panel_shake_hard",
  "panel_shake_subtle",
  "camera_push_in_slow",
  "camera_push_in_fast",
  "camera_pull_back",
  "camera_pan_horizontal",
  "rim_lighting_glow",
  "lens_flare_warm",
  "lens_flare_cool",
  "rain_falling",
  "snow_falling",
  "leaves_drifting",
] as const;
export type EffectTag = (typeof EFFECT_TAGS)[number];

export const AMBIENCE_TAGS = [
  "wind_desert",
  "wind_arctic",
  "city_traffic_distant",
  "rain_steady",
  "energy_hum_low",
  "industrial_machinery",
  "forest_birds",
  "lab_electronics_beep",
  "ocean_waves",
] as const;
export type AmbienceTag = (typeof AMBIENCE_TAGS)[number];

export const SFX_TAGS = [
  "whoosh_metallic_swirl",
  "explosion_distant_muffled",
  "explosion_close_punchy",
  "sword_clang",
  "punch_impact",
  "footstep_concrete",
  "glass_shatter",
  "energy_zap",
  "thunder_distant",
  "vehicle_engine_rev",
] as const;
export type SfxTag = (typeof SFX_TAGS)[number];

export const MUSIC_MOODS = [
  "tense_climax",
  "action_chase",
  "somber_reflective",
  "heroic_triumphant",
  "menacing_villain",
  "comedic_light",
  "mystery_ambient",
  "transition_neutral",
] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export interface AudioTags {
  ambience: AmbienceTag[];
  sfx: SfxTag[];
  music_mood: MusicMood;
}
