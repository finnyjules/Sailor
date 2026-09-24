import type { Measure, RoleKey } from './types'
import { applyFont, createTextLayer, transformCase, wrappedTextLinesMeta } from '~/composables/useCompositorLayers'
import type { TextLayer } from '~/composables/useCompositorLayers'

/** Deterministic measure for tests: 0.55 em per character, letter spacing added per gap,
 *  greedy word wrap, cap metrics 0.35 / 0.35. With `upper` the text is measured in capitals and a
 *  capital letter is 0.7 em — so a test can tell a capitalised element from a plain one. Without
 *  `upper` every character stays 0.55 em (capitals included), exactly as before. */
export function makeStubMeasure(): Measure {
  const w100 = (text: string, _role: RoleKey, ls: number, upper?: boolean) => {
    if (!upper) {
      const n = [...text].length
      return n * 55 + (ls || 0) * 100 * Math.max(0, n - 1)
    }
    const chars = [...text.toUpperCase()]
    const n = chars.length
    const ink = chars.reduce((a, ch) => a + (ch !== ch.toLowerCase() ? 70 : 55), 0)
    return ink + (ls || 0) * 100 * Math.max(0, n - 1)
  }
  const lines = (text: string, role: RoleKey, size: number, ls: number, boxW: number, upper?: boolean) => {
    const out: string[] = []
    // Like the renderer, the lines come back in the case they are drawn in.
    for (const para of (upper ? text.toUpperCase() : text).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean)
      if (!words.length) { out.push(''); continue }
      let cur = ''
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w
        if (cur && w100(t, role, ls, upper) * size / 100 > boxW) { out.push(cur); cur = w } else cur = t
      }
      out.push(cur)
    }
    return out
  }
  return { w100, lines, capAbove: () => 0.35, baseBelow: () => 0.35 }
}

/** The face a Stage 4 content role is measured in when the Frame has no layer for it. */
const CONTENT_FALLBACK: Partial<Record<RoleKey, RoleKey>> = {
  quote: 'details', stat: 'details', by: 'caption', rating: 'caption', list: 'caption', statline: 'caption', them: 'caption',
}

/** Virtual frame width the canvas measure lays out on: 1 kit unit = 10 px. */
const VW = 1000

/** Renderer-exact measure. `layers` gives each role's real TextLayer (family, weight, axes, case).
 *  Uses the renderer's own `applyFont` + `measureText` + `wrappedTextLinesMeta` on a private canvas
 *  at a virtual frame width of 1000 px (1 kit unit = 10 px). Cap metrics come from measuring 'H'
 *  with textBaseline 'middle' (actualBoundingBoxAscent / actualBoundingBoxDescent ÷ font px).
 *  Never caches a zero; falls back to the stub when there is no DOM. */
export function makeCanvasMeasure(layers: Partial<Record<RoleKey, TextLayer>>): Measure {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    if (typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d')
  } catch { ctx = null }
  if (!ctx || typeof ctx.measureText !== 'function') return makeStubMeasure()
  const c = ctx
  const stub = makeStubMeasure()

  // A role with no layer of its own is measured in the nearest role that has one: a Stage 4 content
  // role in the face it was measured in before it had its own (`quote`/`stat`: the details face;
  // the rest: the caption face), every other role in the caption's, then the details', ….
  const base = (role: RoleKey): TextLayer => {
    const own = layers[role]
    if (own) return own
    const near = CONTENT_FALLBACK[role]
    return near ? base(near) : layers.caption ?? layers.details ?? layers.date ?? layers.title
      ?? createTextLayer({ fontWeight: 400 })
  }
  /** The layer's OWN letter case: a case a layout set (Street's capitals, still on the layer after
   *  it was applied) is not the user's — while the layer still holds what the layout wrote, it is
   *  measured in the case it had before (`layoutPrev.textTransform.was`; null: none). */
  const ownCase = (l: TextLayer): TextLayer['textTransform'] => {
    const prev = (l as { layoutPrev?: Record<string, { was: unknown; set: unknown }> }).layoutPrev?.textTransform
    if (prev && l.textTransform === prev.set) return (prev.was ?? undefined) as TextLayer['textTransform']
    return l.textTransform
  }
  /** The role's layer re-sized for measuring: the user's face, weight, axes and case;
   *  the kit's size, spacing and box. Wrap is always the default fit (no shrink/fill).
   *  `upper`: the style sets capitals, whatever the layer's own case. */
  const probe = (role: RoleKey, text: string, size: number, ls: number, boxW?: number, upper?: boolean): TextLayer => {
    const l = base(role)
    return {
      ...l,
      text, fontSize: size / 100, letterSpacing: ls, boxW, boxH: undefined, boxFit: undefined,
      runs: undefined, path: undefined, expressive: undefined,
      textTransform: upper ? 'uppercase' : ownCase(l),
    }
  }

  const wCache = new Map<string, number>()
  const w100 = (text: string, role: RoleKey, ls: number, upper?: boolean): number => {
    const k = (upper ? 'U' : '') + role + '|' + ls + '|' + text
    const hit = wCache.get(k)
    if (hit !== undefined) return hit
    // Size 100 units = 1000 px on the virtual frame; measure at 100 px (size 10) and
    // the px width IS the width in units at size 100.
    const layer = probe(role, text, 10, ls, undefined, upper)
    applyFont(c, layer, VW)
    const v = c.measureText(transformCase(text, layer.textTransform)).width
    if (v > 0) wCache.set(k, v)                     // never remember a zero (face not ready)
    return v > 0 || !text ? v : stub.w100(text, role, ls, upper)
  }

  const lines = (text: string, role: RoleKey, size: number, ls: number, boxW: number, upper?: boolean): string[] =>
    wrappedTextLinesMeta(c, probe(role, text, size, ls, boxW / 100, upper), VW).lines

  const capCache = new Map<RoleKey, [number, number]>()
  const cap = (role: RoleKey): [number, number] => {
    const hit = capCache.get(role)
    if (hit) return hit
    const px = 100
    applyFont(c, probe(role, 'H', px / 10, 0), VW)
    const prev = c.textBaseline
    c.textBaseline = 'middle'
    const m = c.measureText('H')
    c.textBaseline = prev
    const up = (m.actualBoundingBoxAscent ?? 0) / px
    const down = (m.actualBoundingBoxDescent ?? 0) / px
    if (!(up > 0) || !(down > 0)) return [stub.capAbove(role), stub.baseBelow(role)]
    const v: [number, number] = [up, down]
    capCache.set(role, v)
    return v
  }

  return { w100, lines, capAbove: r => cap(r)[0], baseBelow: r => cap(r)[1] }
}
