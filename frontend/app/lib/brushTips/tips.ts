// The three Frame brush tips: labels, hints, the settings each one exposes, and the
// defaults Julien tuned by hand in the prototype (2026-09-26). Values are fractions
// of the prototype baseline (1 = 100%). See docs/superpowers/specs/2026-09-26-frame-brush-tips-design.md.

export type TipId = 'spray' | 'round' | 'bristle'
export const TIP_IDS: readonly TipId[] = ['spray', 'round', 'bristle']

/** Replay units per artboard width. Fixed, so a stroke replays identically at every render size. */
export const REF_W = 1080
export const SIZE_MIN = 4
export const SIZE_MAX = 320
/** Spray's fixed simulation step (1/120 s) and its per-step drip speed decay, exp(−0.9·step).
 *  Here (not in spray.ts) so record.ts can bound the drips without an import cycle. */
export const SPRAY_DT = 1 / 120
export const DRIP_DECAY = Math.exp(-0.9 * SPRAY_DT)

export interface TipSetting { key: string; label: string; default: number; max: number }
export interface TipDef { id: TipId; label: string; hint: string; defaultSize: number; settings: TipSetting[] }

const s = (key: string, label: string, def: number, max = 2): TipSetting => ({ key, label, default: def, max })

export const TIPS: Record<TipId, TipDef> = {
  spray: {
    id: 'spray', label: 'Spray can', defaultSize: 110,
    hint: 'Hold still and the paint pools, then drips. Move fast for a light dusting.',
    settings: [s('speckle', 'Speckle', 0.25), s('overspray', 'Overspray', 0.2), s('drips', 'Drips', 1.75), s('build', 'Build-up', 2), s('relief', 'Relief', 0)],
  },
  round: {
    id: 'round', label: 'Round', defaultSize: 36,
    hint: 'A clean round brush with a little overspray and grain at the edge.',
    settings: [s('softness', 'Softness', 2, 4), s('overspray', 'Overspray', 2, 4), s('grain', 'Grain', 2, 4), s('smoothing', 'Smoothing', 2, 4), s('relief', 'Relief', 0.05, 4)],
  },
  bristle: {
    id: 'bristle', label: 'Bristle', defaultSize: 44,
    hint: 'Slow down for a loaded stroke, flick fast for a dry, broken one.',
    settings: [s('thin', 'Speed thinning', 0.15), s('taper', 'Taper', 0.2), s('dry', 'Dry brush', 0.65), s('load', 'Runs out of paint', 0), s('bristle', 'Bristle texture', 0.5), s('relief', 'Paint thickness', 0.35), s('smoothing', 'Smoothing', 0.6)],
  },
}

export const MASK_HINT = 'Paint to hide part of the selected layer. The eraser brings it back.'

export function defaultSettings(tip: TipId): Record<string, number> {
  const out: Record<string, number> = {}
  for (const st of TIPS[tip].settings) out[st.key] = st.default
  return out
}
