// frontend/app/lib/frame/textMetrics.ts
// A text layer's capitals and baselines, measured the way the renderer lays the lines out
// (spec 2026-09-26-frame-layout-grid-design, "Snapping"). `drawText` draws each line at the MIDDLE
// of its line slot (`textBaseline = 'middle'`, `lineY(i)` below); a capital 'H' measured in that
// mode reaches `up` above the middle and `down` below it, to its baseline — the same reading
// `kit/measure.ts` uses. Offsets are px at width W, measured down from the top of the editor's box
// (`localLayerBox`, centred at y·H + textVAlignCenterOffset), which is the box snapping moves.
import { shallowRef } from 'vue'
import {
  applyFont, fillFontSize, localLayerBox, textVAlignCenterOffset, wrappedTextLinesMeta,
  type TextLayer,
} from '~/composables/useCompositorLayers'

export interface TextMetrics {
  /** The top of the first line's capitals, px below the box top. */
  capTop: number
  /** Each line's baseline, px below the box top, first to last. */
  baselines: number[]
  lines: number
  /** The editor's box height at this width (what `boxPx` returns for the layer), px. */
  boxH: number
}

/** The kit's stub cap metrics (`makeStubMeasure`): 0.35 em above and below the line middle. */
const STUB_UP = 0.35, STUB_DOWN = 0.35
const CACHE_CAP = 512

let _scratch: CanvasRenderingContext2D | null = null
function scratch(): CanvasRenderingContext2D | null {
  if (_scratch) return _scratch
  try {
    if (typeof document !== 'undefined') _scratch = document.createElement('canvas').getContext('2d')
  } catch { _scratch = null }
  return _scratch
}

// One cache per measuring context (a test's fake and the real canvas never share), plus one for
// "no canvas". A font finishing loading changes every reading, so the generation goes into the key.
const _byCtx = new WeakMap<object, Map<string, TextMetrics>>()
const _noCtx = new Map<string, TextMetrics>()
/** Bumped when a web font finishes loading. Reactive, so a computed that measures text and reads
 *  it (`textMetricsGeneration.value`) re-measures when the font arrives. */
export const textMetricsGeneration = shallowRef(0)
/** A font finished loading: every reading may change. */
export function bumpTextMetricsGeneration(): void { _noCtx.clear(); textMetricsGeneration.value++ }
if (typeof document !== 'undefined' && (document as any).fonts?.addEventListener) {
  ;(document as any).fonts.addEventListener('loadingdone', bumpTextMetricsGeneration)
}
function cacheFor(ctx: CanvasRenderingContext2D | null): Map<string, TextMetrics> {
  if (!ctx) return _noCtx
  let m = _byCtx.get(ctx)
  if (!m) { m = new Map(); _byCtx.set(ctx, m) }
  return m
}
function keyOf(l: TextLayer, W: number): string {
  return JSON.stringify([textMetricsGeneration.value, l.text, l.fontFamily, l.fontWeight, l.axes ?? null, l.fontSize, l.lineHeight,
    l.letterSpacing ?? 0, l.textTransform ?? null, l.boxW ?? 0, l.boxH ?? 0, l.boxFit ?? null, l.valign ?? null, W])
}

/** 'H' in the renderer's 'middle' mode: how far its top is above the line middle, and its baseline below. */
function capMetrics(ctx: CanvasRenderingContext2D | null, l: TextLayer, W: number): { up: number; down: number } {
  const px = l.fontSize * W
  if (ctx) {
    applyFont(ctx, l, W)
    const prev = ctx.textBaseline
    ctx.textBaseline = 'middle'
    const m = ctx.measureText('H')
    ctx.textBaseline = prev
    const up = m.actualBoundingBoxAscent ?? 0, down = m.actualBoundingBoxDescent ?? 0
    if (up > 0 && down > 0) return { up, down }
  }
  return { up: STUB_UP * px, down: STUB_DOWN * px }
}

export function textMetrics(layer: TextLayer, W: number, ctx: CanvasRenderingContext2D | null = scratch()): TextMetrics | null {
  // Placed lines, a path and expressive layout don't draw flat lines: they snap as boxes.
  if (layer.runs?.length || layer.path || layer.expressive) return null
  const c = ctx && typeof ctx.measureText === 'function' ? ctx : null
  const cache = cacheFor(c)
  const key = keyOf(layer, W)
  const hit = cache.get(key)
  if (hit) return hit

  // The size the renderer draws at: shrink/fill/break first fit the type to its box (drawText).
  let l = layer
  if (c && l.boxFit && l.boxFit !== 'wrap' && (l.boxW ?? 0) > 0) {
    const fit = fillFontSize(c, l, W)
    l = { ...l, fontSize: l.boxFit === 'shrink' ? Math.min(l.fontSize, fit) : fit }
  }
  const n = wrappedTextLinesMeta(c, l, W).lines.length
  const lineH = l.fontSize * W * l.lineHeight
  const totalH = n * lineH
  const boxHpx = (l.boxH ?? 0) * W
  const H = boxHpx > 0 ? boxHpx : totalH
  const va = l.valign
  const oy = textVAlignCenterOffset(l, H)
  const startY = -totalH / 2 + lineH / 2
  const vJustify = va === 'justify' && n > 1
  // drawText's `lineY(i)`, verbatim: each line's middle relative to the layer origin.
  const mid = (i: number): number => {
    if (!va && boxHpx <= 0) return startY + i * lineH
    if (vJustify) return -H / 2 + lineH / 2 + (i / (n - 1)) * (H - lineH)
    const s = va === 'top' ? -H / 2 + lineH / 2 : va === 'bottom' ? H / 2 - totalH + lineH / 2 : startY
    return s + i * lineH + oy
  }
  // The editor's box (what boxPx returns), and its top relative to the origin.
  const box = localLayerBox(c, layer, W, W)
  const top = textVAlignCenterOffset(layer, box.h) - box.h / 2
  const { up, down } = capMetrics(c, l, W)
  const out: TextMetrics = {
    capTop: mid(0) - up - top,
    baselines: Array.from({ length: n }, (_, i) => mid(i) + down - top),
    lines: n,
    boxH: box.h,
  }
  if (cache.size >= CACHE_CAP) cache.clear()
  cache.set(key, out)
  return out
}
