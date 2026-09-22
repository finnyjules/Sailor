import { wrappedTextLines, type LocalLayer, type TextLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const EPS = 1e-9
const same = (a: number, b: number) => Math.abs(a - b) < EPS

export interface Target { cx: number; cy: number; w?: number; h?: number }

/**
 * Rewrite one layer for its resolved box (box px). `k` is the layoutScale the
 * painter will apply, so a size of T px is stored as T / (W·k). Position only
 * when `w`/`h` are absent. Returns the SAME reference when nothing changes.
 */
export function placeLayer(layer: LocalLayer, t: Target, W: number, H: number, k: number, ctx: CanvasRenderingContext2D | null): LocalLayer {
  const x = t.cx / W, y = t.cy / H
  const unit = W * k
  const patch: Record<string, unknown> = {}
  if (!same(layer.x, x)) patch.x = x
  if (!same(layer.y, y)) patch.y = y
  if (t.w != null || t.h != null) stretchInto(layer, t, unit, x, y, patch)
  if (Object.keys(patch).length === 0) return layer
  return { ...layer, ...patch } as LocalLayer
}

// `cx`/`cy` = the layer's resolved centre in the box's normalized space: a crop mask
// (`LayerMask`) is stored in CANVAS space, so a cover-and-crop mask is centred there.
function stretchInto(layer: LocalLayer, t: Target, unit: number, cx: number, cy: number, patch: Record<string, unknown>) {
  const tw = t.w != null ? t.w / unit : undefined
  const th = t.h != null ? t.h / unit : undefined
  switch (layer.kind) {
    case 'rect': case 'ellipse': case 'polygon': case 'star': {
      if (tw != null && !same(layer.w, tw)) patch.w = tw
      if (th != null && !same(layer.h, th)) patch.h = th
      return
    }
    case 'line': {
      if (tw != null && !same(layer.w, tw)) patch.w = tw
      return
    }
    case 'text': {
      if (tw != null && (layer.boxW ?? 0) > 0 && !same(layer.boxW!, tw)) patch.boxW = tw
      if (th != null && (layer.boxH ?? 0) > 0 && !same(layer.boxH!, th)) patch.boxH = th
      return
    }
    case 'image': case 'wired': {
      // Never distort: cover the target box, crop the overflow with a rect mask
      // centred on the layer (mask coords are normalized like the layer's own).
      const aspect = layer.kind === 'image' ? (layer as ImageLayer).h / (layer as ImageLayer).w : (layer as { lastAspect: number }).lastAspect
      const boxW = tw ?? layer.w, boxH = th ?? layer.w * aspect
      const byW = { w: boxW, h: boxW * aspect }
      const cover = byW.h >= boxH - EPS ? byW : { w: boxH / aspect, h: boxH }
      if (!same(layer.w, cover.w)) patch.w = cover.w
      if (layer.kind === 'image' && !same((layer as ImageLayer).h, cover.h)) patch.h = cover.h
      const needsCrop = cover.w > boxW + EPS || cover.h > boxH + EPS
      if (needsCrop) patch.mask = { kind: 'rect', x: cx, y: cy, w: boxW, h: boxH }
      return
    }
    default: return   // path, brush, deal, scatter: placed only
  }
}

/** Natural height of a boxed text layer at `boxWpx` (design px) — wrapped lines × line height. */
export function textNaturalHeightPx(layer: TextLayer, boxWpx: number, ctx: CanvasRenderingContext2D | null, W0: number): number {
  const probe: TextLayer = { ...layer, boxW: boxWpx / W0 }
  const lines = wrappedTextLines(ctx, probe, W0)
  const lineH = layer.fontSize * W0 * layer.lineHeight
  return Math.max(lines.length, 1) * lineH
}
