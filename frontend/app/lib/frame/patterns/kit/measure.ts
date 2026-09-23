import type { Measure, RoleKey } from './types'
import { applyFont, createTextLayer, transformCase, wrappedTextLinesMeta } from '~/composables/useCompositorLayers'
import type { TextLayer } from '~/composables/useCompositorLayers'

/** Deterministic measure for tests: 0.55 em per character, letter spacing added per gap,
 *  greedy word wrap, cap metrics 0.35 / 0.35. */
export function makeStubMeasure(): Measure {
  const w100 = (text: string, _role: RoleKey, ls: number) => {
    const n = [...text].length
    return n * 55 + (ls || 0) * 100 * Math.max(0, n - 1)
  }
  const lines = (text: string, role: RoleKey, size: number, ls: number, boxW: number) => {
    const out: string[] = []
    for (const para of text.split('\n')) {
      const words = para.split(/\s+/).filter(Boolean)
      if (!words.length) { out.push(''); continue }
      let cur = ''
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w
        if (cur && w100(t, role, ls) * size / 100 > boxW) { out.push(cur); cur = w } else cur = t
      }
      out.push(cur)
    }
    return out
  }
  return { w100, lines, capAbove: () => 0.35, baseBelow: () => 0.35 }
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

  // A role with no layer of its own is measured in the nearest role that has one.
  const base = (role: RoleKey): TextLayer =>
    layers[role] ?? layers.caption ?? layers.details ?? layers.date ?? layers.title
      ?? createTextLayer({ fontWeight: 400 })
  /** The role's layer re-sized for measuring: the user's face, weight, axes and case;
   *  the kit's size, spacing and box. Wrap is always the default fit (no shrink/fill). */
  const probe = (role: RoleKey, text: string, size: number, ls: number, boxW?: number): TextLayer => ({
    ...base(role),
    text, fontSize: size / 100, letterSpacing: ls, boxW, boxH: undefined, boxFit: undefined,
    runs: undefined, path: undefined, expressive: undefined,
  })

  const wCache = new Map<string, number>()
  const w100 = (text: string, role: RoleKey, ls: number): number => {
    const k = role + '|' + ls + '|' + text
    const hit = wCache.get(k)
    if (hit !== undefined) return hit
    // Size 100 units = 1000 px on the virtual frame; measure at 100 px (size 10) and
    // the px width IS the width in units at size 100.
    const layer = probe(role, text, 10, ls)
    applyFont(c, layer, VW)
    const v = c.measureText(transformCase(text, layer.textTransform)).width
    if (v > 0) wCache.set(k, v)                     // never remember a zero (face not ready)
    return v > 0 || !text ? v : stub.w100(text, role, ls)
  }

  const lines = (text: string, role: RoleKey, size: number, ls: number, boxW: number): string[] =>
    wrappedTextLinesMeta(c, probe(role, text, size, ls, boxW / 100), VW).lines

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
