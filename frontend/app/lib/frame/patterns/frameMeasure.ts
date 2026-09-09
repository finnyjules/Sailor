import type { Measure } from './types'

/** A CSS font stack with a generic fallback; multi-word families are quoted.
 *  (Rebuilt here — useCompositorLayers.cssFontStack is not exported.) */
export function fontStack(family: string): string {
  const quoted = /\s/.test(family) ? `"${family}"` : family
  return `${quoted}, system-ui, sans-serif`
}

let _fallbackCtx: CanvasRenderingContext2D | null | undefined
function defaultCtx(): CanvasRenderingContext2D | null {
  if (_fallbackCtx !== undefined) return _fallbackCtx
  try { _fallbackCtx = (typeof document !== 'undefined') ? document.createElement('canvas').getContext('2d') : null }
  catch { _fallbackCtx = null }
  return _fallbackCtx
}

/** width(text) in px at font-size 100, for the engine's linear scaling. No DOM ⇒ length*60. */
export function makeFrameMeasure(family: string, weight: number, ctx?: CanvasRenderingContext2D | null): Measure {
  const c = ctx === undefined ? defaultCtx() : ctx
  if (!c) return (t: string) => t.length * 60
  return (t: string) => { c.font = `${weight} 100px ${fontStack(family)}`; return c.measureText(t).width }
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
