/**
 * The ONE walker over every colour a Frame holds — background, text fills, shape fills,
 * gradient stops, a patterned Fill's a/b/textColor, stroke stacks, image tints, and deal/
 * scatter ink arrays — each yielded as a read/write `ColourSite` with a coverage weight.
 *
 * Everything downstream in Frame recolour (grouping into slots, mapping families, applying a
 * result) reads and writes ONLY through this walker, so reading and writing can never
 * disagree about what a layer's colours are — the same discipline `strokeStackOf` already
 * gives a layer's strokes (see strokeStack.ts's header comment).
 *
 * `set` is written against a root object so a caller (apply.ts) can clone the layer / the
 * `{ background }` holder first and then call `site.set(clone, hex)` — this module never
 * mutates the layers it is given.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import { strokeStackOf } from '~/lib/compositor/strokeStack'
import { isHex, isHexA } from '~/lib/color/convert'

export interface ColourSite {
  owner: string            // layer id, or 'bg'
  path: string             // human path for tests/debug, e.g. 'fill', 'fill.stops[1]', 'strokes[0].paint', 'deal.mosh.inks[3]'
  hex: string               // 6-digit lowercase rgb (alpha stripped)
  alpha?: string            // 2 hex digits when the source was 8-digit, else undefined
  weight: number            // coverage proxy, frame-normalised (bg = 1)
  kind: 'bg' | 'text' | 'shape' | 'stroke' | 'image' | 'ink'
  set: (root: any, hex: string) => void   // writes hex (re-attaching alpha) onto a CLONE root
}

/** Split a 6/8-digit hex into lowercase rgb + optional alpha; null for anything else
 *  (a gradient, a Fill, `rgba(...)`, `''`/`'none'`, undefined, …). */
function splitHex(v: unknown): { hex: string; alpha?: string } | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (isHexA(s)) { const x = s.replace(/^#/, ''); return { hex: '#' + x.slice(0, 6), alpha: x.slice(6, 8) } }
  if (isHex(s)) {
    const x = s.replace(/^#/, '')
    if (x.length === 6) return { hex: '#' + x }
    if (x.length === 3) return { hex: '#' + x[0] + x[0] + x[1] + x[1] + x[2] + x[2] }
  }
  return null
}
const join = (hex: string, alpha?: string) => alpha ? hex + alpha : hex

/** A stroke is a thin band, not a fill — its coverage is a small fraction of the shape it
 *  outlines, so every stroke weight (legacy single-stroke fields AND a stored stroke stack)
 *  scales the shape's own weight down by this factor rather than sharing the fill's weight. */
const STROKE_WEIGHT_FACTOR = 0.03

/** Walk one Paint at `getP()`/`setP()` on a root, emitting a site per solid / stop / Fill colour. */
function paintSites(out: ColourSite[], owner: string, path: string, kind: ColourSite['kind'], weight: number,
  getP: (root: any) => Paint | undefined, setP: (root: any, p: Paint) => void, sample: any) {
  const p = getP(sample)
  if (p == null) return
  if (typeof p === 'string') {
    const h = splitHex(p); if (!h) return
    out.push({ owner, path, hex: h.hex, alpha: h.alpha, weight, kind, set: (root, hex) => setP(root, join(hex, h.alpha)) })
    return
  }
  if (typeof p !== 'object') return
  if ('stops' in p && Array.isArray((p as any).stops)) {
    const stops = (p as any).stops as { color: string }[]
    const w = weight / Math.max(1, stops.length)
    stops.forEach((st, i) => {
      const h = splitHex(st.color); if (!h) return
      out.push({
        owner, path: `${path}.stops[${i}]`, hex: h.hex, alpha: h.alpha, weight: w, kind,
        set: (root, hex) => { const g = getP(root) as any; if (g?.stops?.[i]) g.stops[i].color = join(hex, h.alpha) },
      })
    })
    return
  }
  // A Type-Studio `Fill` (fillTile.ts) — its own colour fields, not a gradient's stops.
  for (const key of ['a', 'b', 'textColor'] as const) {
    const h = splitHex((p as any)[key]); if (!h) continue
    out.push({
      owner, path: `${path}.${key}`, hex: h.hex, alpha: h.alpha, weight: weight / 3, kind,
      set: (root, hex) => { const f = getP(root) as any; if (f && typeof f === 'object') f[key] = join(hex, h.alpha) },
    })
  }
}

/** Emit a site per hex in a string[] at `arrPath` on the layer (deal / scatter inks). */
function inkArraySites(out: ColourSite[], l: any, arrPath: string[], weight: number) {
  const arr = arrPath.reduce((o, k) => o?.[k], l) as unknown
  if (!Array.isArray(arr)) return
  const w = weight / Math.max(1, arr.length)
  arr.forEach((v, i) => {
    const h = splitHex(v); if (!h) return
    out.push({
      owner: l.id, path: `${arrPath.join('.')}[${i}]`, hex: h.hex, alpha: h.alpha, weight: w, kind: 'ink',
      set: (root, hex) => { const a = arrPath.reduce((o, k) => o?.[k], root); if (Array.isArray(a)) a[i] = join(hex, h.alpha) },
    })
  })
}
function inkFieldSites(out: ColourSite[], l: any, objPath: string[], keys: string[], weight: number) {
  const obj = objPath.reduce((o, k) => o?.[k], l)
  if (!obj || typeof obj !== 'object') return
  const w = weight / Math.max(1, keys.length)
  for (const key of keys) {
    const h = splitHex(obj[key]); if (!h) continue
    out.push({
      owner: l.id, path: `${objPath.join('.')}.${key}`, hex: h.hex, alpha: h.alpha, weight: w, kind: 'ink',
      set: (root, hex) => { const o = objPath.reduce((o, k) => o?.[k], root); if (o) o[key] = join(hex, h.alpha) },
    })
  }
}

// Which fields carry ink colours for each active deal `cellFill` / scatter `style`. Only the
// ACTIVE style's fields are walked — the others are dead dials (see the DealLayer/ScatterLayer
// field comments in useCompositorLayers.ts), so their stray colours must not surface as sites.
const DEAL_INKS: Record<string, { arr?: string[]; obj?: { path: string[]; keys: string[] } }> = {
  pane: { arr: ['pane', 'inks'] },
  mosh: { arr: ['mosh', 'inks'] },
  carve: { arr: ['carve', 'inks'] },
  totem: { arr: ['totem', 'inks'] },
  modular: { arr: ['modular', 'inks'], obj: { path: ['modular'], keys: ['bg', 'rule'] } },
  parcel: { obj: { path: ['parcel'], keys: ['ground', 'ink', 'hairline'] } },
  blueprint: { obj: { path: ['blueprint'], keys: ['paper', 'ink', 'inkDim'] } },
}
const SCATTER_INKS: Record<string, string[]> = { chaff: ['chaff', 'inks'], strand: ['strand', 'inks'], husk: ['husk', 'inks'] }

/** Every colour the frame holds, as read/write accessors with a coverage weight (bg = 1). */
export function colourSites(layers: LocalLayer[], background: Paint | undefined, frameAspect: number): ColourSite[] {
  const out: ColourSite[] = []
  // w/h are normalised to frame WIDTH; frameAspect = frameH / frameW, so an area fraction of
  // the frame (width × height, both in frame-width units) is w × h / frameAspect.
  const area = (l: any) => Math.max(0, (l.w ?? 0)) * Math.max(0, (l.h ?? 0)) * (frameAspect > 0 ? 1 / frameAspect : 1)

  paintSites(out, 'bg', 'background', 'bg', 1, r => r.background, (r, p) => { r.background = p }, { background })

  for (const raw of layers) {
    const l = raw as any
    switch (l.kind) {
      case 'text': {
        const w = Math.max(0.002, (l.fontSize ?? 0.05) * String(l.text ?? '').length * 0.55 * (l.fontSize ?? 0.05))
        paintSites(out, l.id, 'color', 'text', w, r => r.color, (r, p) => { r.color = p }, l)
        if ((l.strokeWidth ?? 0) > 0 && !Array.isArray(l.strokes)) paintSites(out, l.id, 'strokeColor', 'stroke', w * STROKE_WEIGHT_FACTOR, r => r.strokeColor, (r, p) => { r.strokeColor = p }, l)
        break
      }
      case 'rect': case 'ellipse': case 'path': case 'polygon': case 'star': case 'brush': {
        const a = Math.max(0.001, l.kind === 'path' || l.kind === 'brush' ? ((l.bbox?.w ?? 0.2) * (l.bbox?.h ?? 0.2) * (l.scale ?? 1) ** 2) : area(l))
        paintSites(out, l.id, 'fill', 'shape', a, r => r.fill, (r, p) => { r.fill = p }, l)
        if (!Array.isArray(l.strokes) && (l.strokeWidth ?? 0) > 0) paintSites(out, l.id, 'stroke', 'stroke', a * STROKE_WEIGHT_FACTOR, r => r.stroke, (r, p) => { r.stroke = p }, l)
        break
      }
      case 'line': {
        paintSites(out, l.id, 'stroke', 'stroke', 0.005, r => r.stroke, (r, p) => { r.stroke = p }, l)
        break
      }
      case 'image': {
        paintSites(out, l.id, 'tint', 'image', area(l) * 0.3, r => r.tint, (r, p) => { r.tint = p }, l)
        break
      }
      case 'deal': {
        const spec = DEAL_INKS[l.cellFill as string]
        if (!spec) break
        const a = Math.max(0.001, area(l))
        if (spec.arr) inkArraySites(out, l, spec.arr, a)
        if (spec.obj) inkFieldSites(out, l, spec.obj.path, spec.obj.keys, a)
        break
      }
      case 'scatter': {
        const arr = SCATTER_INKS[l.style as string]
        if (arr) inkArraySites(out, l, arr, Math.max(0.001, area(l)))
        break
      }
      default: break // wired: no paint of its own
    }
    // Stroke STACK (rect/ellipse/path/polygon/star/text): read through strokeStackOf, write
    // ONLY the stored `strokes` array — never the legacy `stroke`/`strokeColor` field, which
    // the multi-stroke rule (strokeStack.ts) forbids once a layer stores a real stack.
    // `storedStrokeEntries` (the array strokeStackOf reads through) returns `layer.strokes`
    // itself when it is an array, so `strokeStackOf(l)` is index-aligned with `l.strokes` —
    // safe to key the write by index rather than by entry id.
    if (Array.isArray(l.strokes) && l.kind !== 'brush') {
      const entries = strokeStackOf(l)
      const base = Math.max(0.001, area(l)) * STROKE_WEIGHT_FACTOR
      entries.forEach((_e: any, i: number) => {
        if (!l.strokes[i]) return
        paintSites(
          out, l.id, `strokes[${i}].paint`, 'stroke', base / Math.max(1, entries.length),
          r => r.strokes?.[i]?.paint, (r, p) => { if (r.strokes?.[i]) r.strokes[i].paint = p }, l,
        )
      })
    }
  }
  return out
}
