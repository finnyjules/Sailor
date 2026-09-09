import type { Measure } from './types'
import { cssFontStack, transformCase } from '~/composables/useCompositorLayers'
import type { TextLayer } from '~/composables/useCompositorLayers'

/** The renderer's own font stack — measured and painted with the same string. */
export function fontStack(family: string): string { return cssFontStack(family) }

let _fallbackCtx: CanvasRenderingContext2D | null | undefined
function defaultCtx(): CanvasRenderingContext2D | null {
  if (_fallbackCtx !== undefined) return _fallbackCtx
  try { _fallbackCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null }
  catch { _fallbackCtx = null }
  return _fallbackCtx
}

/** What a text layer really renders with: weight from a live wght axis when
 *  present, and the display case transform. */
export function titleMeasureFrom(layer: { fontFamily: string; fontWeight: number; axes?: Record<string, number>; textTransform?: TextLayer['textTransform'] }): { family: string; weight: number; transform: (t: string) => string } {
  const w = layer.axes?.wght
  const weight = (w != null && Number.isFinite(w)) ? Math.round(w) : layer.fontWeight
  const transform = (t: string) => transformCase(t, layer.textTransform)
  return { family: layer.fontFamily, weight, transform }
}

/** width(text) in px at font-size 100, measured on the TRANSFORMED string with
 *  the renderer's font stack. No DOM ⇒ length*60. */
export function makeFrameMeasure(family: string, weight: number, ctx?: CanvasRenderingContext2D | null, transform: (t: string) => string = t => t): Measure {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return (t: string) => transform(t).length * 60
  return (t: string) => { c.font = `${weight} 100px ${fontStack(family)}`; return c.measureText(transform(t)).width }
}

/** Cap-height / ascent / descent in px at `sizePx`, from TextMetrics, with
 *  size-proportional fallbacks when a metric is 0/absent (Space Type precedent). */
export function capMetrics(family: string, weight: number, sizePx: number, ctx?: CanvasRenderingContext2D | null): { cap: number; ascent: number; descent: number } {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return { cap: sizePx * 0.72, ascent: sizePx * 0.8, descent: sizePx * 0.2 }
  c.font = `${weight} ${sizePx}px ${fontStack(family)}`
  const m = c.measureText('H')
  return {
    cap: m.actualBoundingBoxAscent || sizePx * 0.72,
    ascent: m.fontBoundingBoxAscent || sizePx * 0.8,
    descent: m.fontBoundingBoxDescent || sizePx * 0.2,
  }
}
