// Entry point for the Frame's brush branch: tip strokes → one coverage canvas (white, alpha =
// paint) plus an optional shade canvas, both view-sized. Groups composite in order: paint
// groups source-over, erase groups destination-out. Cached per layer key + stroke identity + view.
//
// Size cap: a view larger than MAX_SIDE (8192) on either side is rendered at a reduced size
// (unitPx scaled so the largest side is 8192) and the canvases come back at that size — the
// caller's drawImage(canvas, x, y, viewW, viewH) stretches them. See engine.ts capView.
import type { PaintStroke } from '~/lib/compositor/brushStamp'
import { isTipStroke, type TipStroke } from './record'
import { rasterGroup, capView, type TipGroup, type CoverageView } from './engine'

export type { TipGroup, CoverageView } from './engine'

export function groupTipStrokes(strokes: (PaintStroke | TipStroke)[]): TipGroup[] {
  const out: TipGroup[] = []
  for (const s of strokes) {
    if (!isTipStroke(s)) continue
    const erase = !!s.erase, last = out[out.length - 1]
    if (!erase && last && !last.erase && last.tip === s.tip) last.strokes.push(s)
    else out.push({ tip: s.tip, erase, strokes: [s] })
  }
  return out
}

interface Entry { sig: string; strokes: readonly unknown[]; coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null }
const cache = new Map<string, Entry>()
const CACHE_MAX = 48

export function renderTipCoverage(key: string, strokes: (PaintStroke | TipStroke)[], view: CoverageView, live?: TipStroke | null, liveTailMs = 0): { coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null } | null {
  const all = live ? [...strokes, live] : strokes
  const groups = groupTipStrokes(all)
  if (!groups.length) return null
  const sig = `${view.originX.toFixed(3)}|${view.originY.toFixed(3)}|${view.unitPx.toFixed(5)}|${view.w}x${view.h}|${all.length}`
  const hit = cache.get(key)
  if (!live && hit && hit.sig === sig && hit.strokes.length === all.length && hit.strokes.every((s, i) => s === all[i])) return hit
  const v = capView(view)
  const coverage = document.createElement('canvas'); coverage.width = v.w; coverage.height = v.h
  let shade: HTMLCanvasElement | null = null
  const cctx = coverage.getContext('2d')!
  for (const g of groups) {
    const r = rasterGroup(g, v, live ?? null, liveTailMs)
    cctx.globalCompositeOperation = g.erase ? 'destination-out' : 'source-over'
    // Explicit size: the GPU may have capped lower still (its own texture limit); stretch back.
    cctx.drawImage(r.coverage as CanvasImageSource, 0, 0, v.w, v.h)
    if (r.shade && !g.erase) {
      if (!shade) { shade = document.createElement('canvas'); shade.width = v.w; shade.height = v.h }
      shade.getContext('2d')!.drawImage(r.shade, 0, 0, v.w, v.h)
    }
  }
  if (shade) { const s = shade.getContext('2d')!; s.globalCompositeOperation = 'destination-in'; s.drawImage(coverage, 0, 0) }
  const entry: Entry = { sig, strokes: all.slice(), coverage, shade }
  if (!live) { cache.delete(key); cache.set(key, entry); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!) }
  return entry
}
