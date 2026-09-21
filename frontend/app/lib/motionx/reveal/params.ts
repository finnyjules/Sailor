// A REVEAL is a whole-layer transition drawn through a mask: every pixel of the layer is
// either shown or hidden, decided per frame from ONE animated number (the amount, 0 → 1)
// plus the look's dials. This file is the vocabulary; `dither.ts` is the maths; `paint.ts`
// is the only canvas-aware part. Pure: no Vue, no DOM.
export type RevealStyle = 'dissolve' | 'wipe' | 'dots'
export const REVEAL_STYLES: readonly RevealStyle[] = ['dissolve', 'wipe', 'dots']

/** The dials as the MATHS wants them: `cell` a fraction of the frame's width, `angle` radians. */
export interface RevealParams { style: RevealStyle; out: boolean; cell: number; drift: number; angle: number; softness: number }
/** What the fold parks on a layer clone for one frame. Transient — never persisted. */
export interface MotionReveal extends RevealParams { amount: number; elapsed: number }

/** Defaults in STORED units (what `behaviour.params` holds and the inspector shows). */
export const REVEAL_DEFAULTS = { style: 'dissolve' as RevealStyle, cell: 8, drift: 6, angle: 0, softness: 0.35 }
export const REVEAL_RANGES = { cell: [1, 40], drift: [0, 30], angle: [0, 360], softness: [0, 1] } as const

const num = (v: unknown, d: number, [lo, hi]: readonly [number, number]) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** The ONE reader of a dither bar's stored params. Unknown enum / non-finite number → default;
 *  out-of-range number → clamped. */
export function revealParams(params: Record<string, unknown> | undefined): RevealParams {
  const p = params ?? {}
  const style = (REVEAL_STYLES as readonly unknown[]).includes(p.style) ? (p.style as RevealStyle) : REVEAL_DEFAULTS.style
  return {
    style,
    out: p.dir === 'out',
    cell: num(p.cell, REVEAL_DEFAULTS.cell, REVEAL_RANGES.cell) / 1000,
    drift: num(p.drift, REVEAL_DEFAULTS.drift, REVEAL_RANGES.drift),
    angle: (num(p.angle, REVEAL_DEFAULTS.angle, REVEAL_RANGES.angle) * Math.PI) / 180,
    softness: num(p.softness, REVEAL_DEFAULTS.softness, REVEAL_RANGES.softness),
  }
}
