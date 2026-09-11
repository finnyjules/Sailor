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
import { layerStoresStrokeStack, strokeStackOf, strokeSupportsStack } from '~/lib/compositor/strokeStack'
import { isHex, isHexA } from '~/lib/color/convert'

export interface ColourSite {
  owner: string            // layer id, or 'bg'
  path: string             // human path for tests/debug, e.g. 'fill', 'fill.stops[1]', 'strokes[0].paint', 'deal.mosh.inks[3]'
  hex: string               // 6-digit lowercase rgb (alpha stripped)
  alpha?: string            // 2 hex digits when the source was 8-digit, else undefined
  weight: number            // coverage proxy, frame-normalised (bg = 1)
  kind: 'bg' | 'text' | 'shape' | 'stroke' | 'image' | 'ink'
  set: (root: any, hex: string, alpha?: string) => void   // writes hex (re-attaching alpha, or an override) onto a CLONE root
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
const join = (hex: string, alpha?: string) => alpha && alpha !== 'ff' ? hex + alpha : hex

/** A stroke is a thin band, not a fill — its coverage is a small fraction of the shape it
 *  outlines, so every stroke weight (legacy single-stroke fields AND a stored stroke stack)
 *  scales the shape's own weight down by this factor rather than sharing the fill's weight.
 *
 *  The honest proxy for a band's coverage is its own area — perimeter × width — not a flat
 *  fraction of the shape's area. For this module's own test fixture (a 0.4×0.2 rect, frame-
 *  width-normalised, with a typical 0.01-wide stroke): perimeter = 2×(0.4+0.2) = 1.2, so
 *  perimeter × width ≈ 1.2 × 0.01 = 0.012 — about 15% of the shape's own area (0.08), which
 *  is roughly where this constant (0.08 × 0.03 = 0.0024, ~3%) undershoots on a squarish
 *  shape. Computing perimeter × width directly was tried and rejected: it swings with a
 *  layer's aspect ratio in a way a flat fraction of area doesn't (a long thin rect's
 *  perimeter dwarfs its area, so its stroke would outweigh its own fill), and for this exact
 *  suite's "a stroke is light" fixture it comes out heavier than a "small" text label,
 *  failing the assertion the constant is tuned to keep. So this stays a flat fraction of the
 *  shape's own area/weight — small enough that a stroke never outweighs the fill or text it
 *  sits next to. */
const STROKE_WEIGHT_FACTOR = 0.03

/** Walk one Paint at `getP()`/`setP()` on a root, emitting a site per solid / stop / Fill colour. */
function paintSites(out: ColourSite[], owner: string, path: string, kind: ColourSite['kind'], weight: number,
  getP: (root: any) => Paint | undefined, setP: (root: any, p: Paint) => void, sample: any) {
  const p = getP(sample)
  if (p == null) return
  if (typeof p === 'string') {
    const h = splitHex(p); if (!h) return
    out.push({ owner, path, hex: h.hex, alpha: h.alpha, weight, kind, set: (root, hex, alpha) => setP(root, join(hex, alpha ?? h.alpha)) })
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
        set: (root, hex, alpha) => { const g = getP(root) as any; if (g?.stops?.[i]) g.stops[i].color = join(hex, alpha ?? h.alpha) },
      })
    })
    return
  }
  // A Type-Studio `Fill` (fillTile.ts) — its own colour fields, not a gradient's stops.
  // A shader Fill's `a`/`b`/`textColor` are vestigial (fillTile.ts's `effectiveTileFill`
  // degrades a shader fill to its `shader.input`, never to these fields), so recolouring
  // them would touch dead data while leaving what actually renders untouched. Recursing
  // into `shader.input` instead is out of scope here — the walker only follows the fields
  // this Fill itself owns.
  if ((p as any).type === 'shader') return
  for (const key of ['a', 'b', 'textColor'] as const) {
    const h = splitHex((p as any)[key]); if (!h) continue
    out.push({
      owner, path: `${path}.${key}`, hex: h.hex, alpha: h.alpha, weight: weight / 3, kind,
      set: (root, hex, alpha) => { const f = getP(root) as any; if (f && typeof f === 'object') f[key] = join(hex, alpha ?? h.alpha) },
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
      set: (root, hex, alpha) => { const a = arrPath.reduce((o, k) => o?.[k], root); if (Array.isArray(a)) a[i] = join(hex, alpha ?? h.alpha) },
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
      set: (root, hex, alpha) => { const o = objPath.reduce((o, k) => o?.[k], root); if (o) o[key] = join(hex, alpha ?? h.alpha) },
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

/** A text layer's glyph-coverage proxy, frame-aspect-normalised exactly as `area()` is (both
 *  are frame-width-unit quantities, and a taller/narrower frame packs the same glyph run into
 *  a bigger or smaller true-area fraction) — shared by the fill-site weight below and
 *  `strokeWeightBase`'s text branch so a stroke's weight and its own fill's weight are always
 *  computed the same way for the same layer. */
function textWeightProxy(l: any, frameAspect: number): number {
  const w = Math.max(0.002, (l.fontSize ?? 0.05) * String(l.text ?? '').length * 0.55 * (l.fontSize ?? 0.05))
  return w * (frameAspect > 0 ? 1 / frameAspect : 1)
}

/** A stroke site's weight, ONE formula shared by both the legacy single site and the stack
 *  (the stack then splits it further, per entry, in the caller). Kept a function rather than
 *  inlined twice — legacy and stack must agree on a layer's base weight or two reads of the
 *  same layer under different stroke states would jump discontinuously. Text scales with its
 *  own glyph-coverage proxy (matching its fill-site weight in the switch above); every other
 *  stackable kind and brush share the shape-area proxy the `path`/`brush` fill site already
 *  uses (a `bbox`-derived area for a freeform outline, the frame-normalised `area(l)`
 *  otherwise). */
function strokeWeightBase(l: any, area: (l: any) => number, frameAspect: number): number {
  if (l.kind === 'text') return textWeightProxy(l, frameAspect) * STROKE_WEIGHT_FACTOR
  const a = Math.max(0.001, l.kind === 'path' || l.kind === 'brush' ? ((l.bbox?.w ?? 0.2) * (l.bbox?.h ?? 0.2) * (l.scale ?? 1) ** 2) : area(l))
  return a * STROKE_WEIGHT_FACTOR
}

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
        const w = textWeightProxy(l, frameAspect)
        paintSites(out, l.id, 'color', 'text', w, r => r.color, (r, p) => { r.color = p }, l)
        break
      }
      case 'rect': case 'ellipse': case 'path': case 'polygon': case 'star': case 'brush': {
        const a = Math.max(0.001, l.kind === 'path' || l.kind === 'brush' ? ((l.bbox?.w ?? 0.2) * (l.bbox?.h ?? 0.2) * (l.scale ?? 1) ** 2) : area(l))
        paintSites(out, l.id, 'fill', 'shape', a, r => r.fill, (r, p) => { r.fill = p }, l)
        break
      }
      case 'line': {
        if ((l.strokeWidth ?? 0) > 0) paintSites(out, l.id, 'stroke', 'stroke', 0.005, r => r.stroke, (r, p) => { r.stroke = p }, l)
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
    // Stroke sites: follow `strokeStackOf`'s OWN precedence exactly, never re-derive it from
    // `Array.isArray(l.strokes)` alone — that flag says a `strokes` field exists, not which
    // one the reader actually uses. A layer can carry BOTH a live legacy `stroke`/
    // `strokeColor` (non-empty ink, `strokeWidth > 0`) AND a fully-id'd stored `strokes`
    // array; `storedStrokeEntries` (strokeStack.ts:187) treats that combination as an older
    // build editing a newer document and returns `null` — the array is stale, the legacy
    // field is what the painter draws. `layerStoresStrokeStack` is the same question asked
    // the way every other consumer asks it, so the walker can never offer a site the reader
    // ignores, nor hide the one it renders.
    //
    // Brush is excluded outright, kind by kind rather than through the stack question at
    // all: a `BrushLayer`'s `strokes` is its freehand `PaintStroke[]` path data — unrelated
    // to the outline stack, and not a member of `STACKABLE` (strokeStack.ts:79) — so it must
    // never be read as one, in either direction. Its legacy `stroke`/`strokeWidth` fields
    // still read through normally, same as `strokeStackOf`'s own comment for a brush notes.
    if (l.kind === 'brush') {
      if ((l.strokeWidth ?? 0) > 0) {
        const base = strokeWeightBase(l, area, frameAspect)
        paintSites(out, l.id, 'stroke', 'stroke', base, r => r.stroke, (r, p) => { r.stroke = p }, l)
      }
    } else if (strokeSupportsStack(l.kind)) {
      const strokeField = l.kind === 'text' ? 'strokeColor' : 'stroke'
      if (layerStoresStrokeStack(l)) {
        // `storedStrokeEntries` (the array `strokeStackOf` reads through) returns
        // `layer.strokes` unchanged — same length, same order — whenever it returns
        // non-null (every entry already carries a real id, or `allIded` would be false and
        // this branch would not be taken), so `strokeStackOf(l)` is index-aligned with
        // `l.strokes` here — safe to key the write by index rather than by entry id.
        const entries = strokeStackOf(l)
        const base = strokeWeightBase(l, area, frameAspect)
        entries.forEach((_e: any, i: number) => {
          if (!l.strokes[i]) return
          paintSites(
            out, l.id, `strokes[${i}].paint`, 'stroke', base / Math.max(1, entries.length),
            r => r.strokes?.[i]?.paint, (r, p) => { if (r.strokes?.[i]) r.strokes[i].paint = p }, l,
          )
        })
      } else if ((l.strokeWidth ?? 0) > 0) {
        // Exactly ONE legacy site, even when a stale `strokes` array also sits on the
        // layer (the mixed case above) — writing the legacy field is exactly what
        // `strokeStackOf` reads in that case, so the stale array is correctly left
        // untouched by `set`.
        const base = strokeWeightBase(l, area, frameAspect)
        paintSites(out, l.id, strokeField, 'stroke', base, r => r[strokeField], (r, p) => { r[strokeField] = p }, l)
      }
    }
  }
  return out
}
