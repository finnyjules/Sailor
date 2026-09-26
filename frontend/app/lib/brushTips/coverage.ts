// Entry point for the Frame's brush branch: tip strokes → one coverage canvas (white, alpha =
// paint) plus an optional shade canvas, both view-sized. Groups composite in order: paint
// groups source-over, erase groups destination-out. Cached per layer key + stroke identity + view.
//
// `base` (optional): the offscreen already holding the layer's LEGACY stamps. The groups then
// composite onto a copy of it, so a tip eraser cuts legacy paint too, and the returned coverage
// is the whole layer (the caller replaces its offscreen with it). Legacy strokes are part of the
// cache's stroke-identity check, so a changed legacy stroke is a miss.
//
// Size cap: a view larger than MAX_SIDE (8192) on either side is rendered at a reduced size
// (unitPx scaled so the largest side is 8192) and the canvases come back at that size — the
// caller's drawImage(canvas, x, y, viewW, viewH) stretches them. See engine.ts capView.
import type { PaintStroke } from '~/lib/compositor/brushStamp'
import { LruCache } from '~/lib/compositor/silhouetteCache'
import { isTipStroke, type TipStroke } from './record'
import { rasterGroup, capView, tipRenderPath, type TipGroup, type CoverageView, type GroupPaint } from './engine'

export type { TipGroup, CoverageView, GroupPaint } from './engine'

/** The material part of the cache signature: '' without paint, `${id}@0` when still, else the
 *  time bucketed to 1/30 s — so a moving material re-renders once per bucket, a still one never. */
export function paintKey(paint: GroupPaint | undefined): string {
  if (!paint) return ''
  if (paint.t === 0) return `${paint.material}@0`
  return `${paint.material}@t${(Math.round(paint.t * 30) / 30).toFixed(3)}`
}

/** Whether two strokes of one tip agree on every setting the renderer applies per GROUP (the
 *  grain / shade pass): relief for every tip, grain for round. Only such strokes may share a
 *  group — otherwise the group would take one stroke's value for all of them, and painting,
 *  undoing or changing a later stroke would change how an earlier one looks. */
function sameGroupSettings(a: TipStroke, b: TipStroke): boolean {
  if ((a.settings.relief ?? 0) !== (b.settings.relief ?? 0)) return false
  if (a.tip === 'round' && (a.settings.grain ?? 0) !== (b.settings.grain ?? 0)) return false
  return true
}

export function groupTipStrokes(strokes: (PaintStroke | TipStroke)[]): TipGroup[] {
  const out: TipGroup[] = []
  for (const s of strokes) {
    if (!isTipStroke(s)) continue
    const erase = !!s.erase, last = out[out.length - 1]
    if (!erase && last && !last.erase && last.tip === s.tip && sameGroupSettings(last.strokes[0]!, s)) last.strokes.push(s)
    else out.push({ tip: s.tip, erase, strokes: [s] })
  }
  return out
}

type Canvas = HTMLCanvasElement
interface Composite { coverage: Canvas; shade: Canvas | null; gpu: boolean }
interface Entry extends Composite { sig: string; strokes: readonly unknown[] }

const canvasBytes = (c: Canvas | null) => (c ? c.width * c.height * 4 : 0)
/** Byte budget for committed renders (4 bytes per device px, coverage + shade), like the
 *  silhouette cache's: the values are device-resolution canvases, so a count cap alone could
 *  hold hundreds of MB. LRU entries are shed until the total is back under it. */
export const TIP_COVERAGE_MAX_BYTES = 192 * 1024 * 1024
const cache = new LruCache<Entry>(48, { sizeOf: e => canvasBytes(e.coverage) + canvasBytes(e.shade), maxBytes: TIP_COVERAGE_MAX_BYTES })
// While a stroke is live: per layer, the composite of every group BEFORE the live stroke's
// group (plus the base). Each live frame then re-rasters only the live group. Dropped by the
// layer's next committed render.
const prefixes = new Map<string, Entry>()

function blank(v: CoverageView): Canvas { const c = document.createElement('canvas'); c.width = v.w; c.height = v.h; return c }

/** Composite `groups` in order over `from` (copied, never mutated) or over `base`. The shade
 *  comes back UNMASKED (the caller masks it by the final coverage). */
function compose(v: CoverageView, groups: TipGroup[], from: Composite | null, base: CanvasImageSource | null | undefined, live: TipStroke | null, liveTailMs: number, paint?: GroupPaint): Composite {
  const coverage = blank(v)
  const cctx = coverage.getContext('2d')!
  let shade: Canvas | null = null
  let gpu = from ? from.gpu : true
  if (from) cctx.drawImage(from.coverage, 0, 0)
  else if (base) cctx.drawImage(base, 0, 0, v.w, v.h)
  if (from?.shade) { shade = blank(v); shade.getContext('2d')!.drawImage(from.shade, 0, 0) }
  for (const g of groups) {
    const r = g.erase ? rasterGroup(g, v, live, liveTailMs) : rasterGroup(g, v, live, liveTailMs, paint)
    if (!r.gpu) gpu = false
    cctx.globalCompositeOperation = g.erase ? 'destination-out' : 'source-over'
    // Explicit size: the GPU may have capped lower still (its own texture limit); stretch back.
    cctx.drawImage(r.coverage as CanvasImageSource, 0, 0, v.w, v.h)
    if (r.shade && !g.erase) {
      if (!shade) shade = blank(v)
      shade.getContext('2d')!.drawImage(r.shade, 0, 0, v.w, v.h)
    }
  }
  cctx.globalCompositeOperation = 'source-over'
  return { coverage, shade, gpu }
}

/** Mask the shade by the final coverage (erase groups cut it too). Mutates `c.shade`. */
function finish(c: Composite): Composite {
  if (c.shade) { const s = c.shade.getContext('2d')!; s.globalCompositeOperation = 'destination-in'; s.drawImage(c.coverage, 0, 0); s.globalCompositeOperation = 'source-over' }
  return c
}

const sameStrokes = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((s, i) => s === b[i])
/** A cached raster is usable when it matches, unless it is a 2D fallback made while the GPU
 *  was lost and the GPU is back — then it is redrawn properly. */
const usable = (e: Entry | undefined, sig: string, strokes: readonly unknown[], path: 'gpu' | '2d') =>
  !!e && e.sig === sig && sameStrokes(e.strokes, strokes) && (e.gpu || path === '2d')

export function renderTipCoverage(
  key: string, strokes: (PaintStroke | TipStroke)[], view: CoverageView,
  live?: TipStroke | null, liveTailMs = 0, base?: CanvasImageSource | null, paint?: GroupPaint,
): { coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null } | null {
  const all = live ? [...strokes, live] : strokes
  const groups = groupTipStrokes(all)
  if (!groups.length) return null
  const path = tipRenderPath()
  const sig = `${view.originX.toFixed(3)}|${view.originY.toFixed(3)}|${view.unitPx.toFixed(5)}|${view.w}x${view.h}|${base ? 'base' : ''}|${paintKey(paint)}`
  const v = capView(view)

  if (!live) {
    prefixes.delete(key)
    const hit = cache.get(key)
    if (usable(hit, sig, all, path)) return hit!
    const c = finish(compose(v, groups, null, base, null, 0, paint))
    const entry: Entry = { ...c, sig, strokes: all.slice() }
    cache.set(key, entry)
    return entry
  }

  // Live: the live stroke is last in `all`, so it is in the last group. Everything before that
  // group is committed and unchanged frame to frame — composite it once, then per frame copy
  // it and raster only the live group.
  const liveGroup = groups[groups.length - 1]!
  const psig = `${sig}|${liveGroup.strokes.length - 1}`
  let prefix = prefixes.get(key)
  if (!usable(prefix, psig, strokes, path)) {
    const c = compose(v, groups.slice(0, -1), null, base, null, 0, paint)
    prefix = { ...c, sig: psig, strokes: strokes.slice() }
    prefixes.set(key, prefix)
  }
  return finish(compose(v, [liveGroup], prefix!, null, live, liveTailMs, paint))
}
