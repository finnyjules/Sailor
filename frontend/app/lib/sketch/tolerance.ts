import { pxPerUnit, type ViewMatrix } from './view'

/** Pen tolerances in SCREEN pixels, so they feel the same at any zoom and in any
 *  host. Values are the dev page's historical world-unit constants × its default
 *  34 px/unit (0.6, 0.15, 0.2), so the dev page behaves byte-identically at that zoom. */
export const SNAP_PX = 20.4
export const BOW_PX = 5.1
export const MIN_RADIUS_PX = 6.8

export function pxToUnits(px: number, m: ViewMatrix): number {
  const s = pxPerUnit(m)
  return s > 0 ? px / s : px
}
