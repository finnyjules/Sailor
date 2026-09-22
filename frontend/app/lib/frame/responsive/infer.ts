import type { AxisPin, PinH, PinV } from './types'

/** Spanning this fraction of the reference (or more) reads as "stretch". */
export const SPAN_STRETCH = 0.8
/** A centre within this fraction of the reference centre reads as "centred". */
export const CENTER_TOL = 0.04

export interface Box { x: number; y: number; w: number; h: number }

/**
 * The default pin for one axis, from where a box sits inside its reference
 * rectangle (design px). This is THE replaceable rule: a later "Suggest pins"
 * step writes ordinary stored pins instead of changing this.
 *
 *   1. spans ≥ SPAN_STRETCH of the axis, or touches both edges, and can stretch → 'both'
 *   2. centre within CENTER_TOL of the reference centre → 'center'
 *   3. otherwise the nearer edge
 * 'relative' is never inferred.
 */
export function inferAxisPin(start: number, extent: number, refStart: number, refExtent: number, canStretch: boolean): AxisPin {
  if (refExtent <= 0) return 'center'
  const span = extent / refExtent
  const touchesBoth = start <= refStart + 1e-6 && start + extent >= refStart + refExtent - 1e-6
  if (span >= SPAN_STRETCH || touchesBoth) return canStretch ? 'both' : 'center'
  const c = start + extent / 2
  const refC = refStart + refExtent / 2
  if (Math.abs(c - refC) <= CENTER_TOL * refExtent) return 'center'
  return c < refC ? 'left' : 'right'
}

const V_NAME: Record<AxisPin, PinV> = { left: 'top', right: 'bottom', both: 'both', center: 'middle', relative: 'relative' }

/** Both axes at once, with the vertical axis spelled in its own names. */
export function inferPins(box: Box, ref: Box, canStretch: boolean): { h: PinH; v: PinV } {
  const h = inferAxisPin(box.x, box.w, ref.x, ref.w, canStretch)
  const v = V_NAME[inferAxisPin(box.y, box.h, ref.y, ref.h, canStretch)]
  return { h, v }
}

/** Vertical pin name → the axis-neutral name the maths uses. */
export function axisOfV(v: PinV): AxisPin {
  return v === 'top' ? 'left' : v === 'bottom' ? 'right' : v === 'middle' ? 'center' : v
}
