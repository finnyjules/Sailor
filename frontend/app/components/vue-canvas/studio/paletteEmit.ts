// Emit-decision helpers for the seed-engine pane in PalettePicker.vue.
// The seed engine hands back a PaletteFamily whose hexes were chosen because
// of their own individual lightness (dark accents, light highlights, etc).
// `toStops`/`toDuotone` (harmony.ts) COOK a palette onto a fixed lightness
// ramp — great for the curated-gallery/harmony panes, wrong here: it would
// silently rewrite every hex the seed engine picked. `familyToStops` is the
// literal projection: same colors, sorted by their own lightness, never
// remapped. Never import toStops/toDuotone into this file.
import { gradientize } from '~/lib/color/project'
import type { GradientStop } from '~/lib/color/harmony'

/** Literal projection for the seed-engine path — NEVER toStops. */
export function familyToStops(hexes: string[]): GradientStop[] {
  return gradientize(hexes)
}
