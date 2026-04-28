# Effect Library

## Status: `pending`
## Goal: A small reusable library of CSS / canvas / SVG motion effects keyed to Gemini-tagged effect categories
## Cost: $0 — pure web tech, all libraries MIT-licensed

---

## Architecture

Single React component per effect tag, registered in a map:

```ts
// src/components/motion-comic/effects/registry.ts
import { EnergyPortalBlue } from "./EnergyPortalBlue";
import { SmokeBillow } from "./SmokeBillow";
// ...

export const EFFECTS: Record<string, ComponentType<EffectProps>> = {
  energy_portal_blue: EnergyPortalBlue,
  smoke_billow: SmokeBillow,
  // ...
};

export interface EffectProps {
  /** 0..1 fraction of the panel — rendered relative to the panel container */
  bbox?: { x: number; y: number; w: number; h: number };
  /** Active when panel is the focused panel in panel-view mode */
  active: boolean;
  /** 0..1 progression through the panel's display window — drives effect intensity */
  progress: number;
}
```

`PanelView` reads the panel's `effectTags` and renders each as a layered absolutely-positioned element. Effects are stacked by tag order. The library's job is to make every tag look "good enough" with zero hand tuning.

---

## v1 effect inventory

Build these first — they cover the bulk of comic-typical scenes.

### Camera / framing effects (CSS transforms on the page layer)
| Tag | Mechanism | Notes |
|---|---|---|
| `camera_push_in_slow` | `scale(1.0 → 1.06)` over panel duration | Baseline cinematic feel |
| `camera_push_in_fast` | `scale(1.0 → 1.15)` in first 0.6s | For impacts / reveals |
| `camera_pull_back` | `scale(1.04 → 1.0)` | Beat-resolution shots |
| `camera_pan_horizontal` | `translate3d(±2%)` | Action sequences |
| `panel_shake_subtle` | 4 px random translate at 8Hz, 0.4s | Background tension |
| `panel_shake_hard` | 12 px random translate at 12Hz, 0.6s | Big impacts |

### Light effects (CSS box-shadow / SVG / mix-blend-mode)
| Tag | Mechanism |
|---|---|
| `rim_lighting_glow` | Animated `box-shadow` outside the panel bbox, color from a per-effect palette |
| `lens_flare_warm` | Layered radial-gradient SVG with `mix-blend-mode: screen`, slow drift |
| `lens_flare_cool` | Same as above, cooler palette |

### Particle effects (`tsParticles` — MIT, ~30 KB gz)
| Tag | Particle config |
|---|---|
| `smoke_drift` | Soft grey particles, slow upward, `blur: 6px` |
| `smoke_billow` | Larger denser clouds, animated `scale: 0 → 1.2 → 0` lifecycle |
| `fire_flicker` | Yellow/orange/red layered, fast lifecycle, additive blend |
| `embers_rising` | Tiny bright pixels, upward, slight horizontal drift |
| `rain_falling` | Many thin streaks, fixed angle, fast |
| `snow_falling` | Slower, sinusoidal horizontal drift |
| `leaves_drifting` | Sparse, rotating sprites, slow |

### Energy / sci-fi effects (canvas + shader-light)
| Tag | Mechanism |
|---|---|
| `energy_portal_blue` | Concentric rings + crackling line segments via canvas, hue-locked blue |
| `energy_portal_red` | Same as above, red |
| `energy_portal_green` | Same as above, green |
| `impact_lines_radial` | SVG converging lines from the panel center, animated stroke-dashoffset |
| `speed_lines_horizontal` | SVG horizontal lines, animated translateX, randomized |
| `speed_lines_diagonal` | Same as above, rotated 25° |

---

## Implementation order

Tackle them in three buckets:

1. **CSS-only (today, half a day):** all camera/framing + rim_lighting_glow + speed_lines_*. Pure CSS keyframes + a single `<div>` per effect. No deps.
2. **Particle (one day):** install `tsParticles`, build smoke/fire/embers/rain/snow/leaves with shared base config + per-effect overrides.
3. **Canvas energy (one day):** build the portal + impact_lines on a single shared canvas; one render loop per panel.

Skip lens_flare for v1 if time-pressed — it's polish.

---

## Performance budget

The reader runs on a phone. Constraints:
- Max one canvas + ts-particles instance active at a time (only the focused panel)
- Inactive panels' effects unmounted (not just hidden) to free GPU
- All effects respect `prefers-reduced-motion: reduce` → render a static representation (single smoke puff, static glow, etc.)

---

## Test coverage

Per effect, snapshot a still frame at 30%, 60%, 90% of `progress`. Visual regression checks are too costly; instead, eye-test once per effect on 3 sample panels and lock the params.

---

## Future expansion

When new tags are needed:
1. Add the tag to the Gemini prompt enum (spec 01)
2. Add the component to `EFFECTS` map
3. Re-run `direct-panels` for any issue that should pick up the new tag

Tag enum lives in **one file** so the prompt and the registry can't drift.

```ts
// src/components/motion-comic/effects/tags.ts
export const EFFECT_TAGS = [
  "energy_portal_blue",
  "energy_portal_red",
  // ...
] as const;
export type EffectTag = (typeof EFFECT_TAGS)[number];
```

The Gemini prompt builder reads from `EFFECT_TAGS` and inlines them, so the enum is genuinely single-source.
