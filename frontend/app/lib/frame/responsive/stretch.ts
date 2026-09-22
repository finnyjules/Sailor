import { wrappedTextLines, type LayerMask, type LocalLayer, type TextLayer, type ImageLayer, type WiredLayer } from '~/composables/useCompositorLayers'
import type { Cloner } from '~/composables/useCloner'
import { wiredLayerHeight } from '~/lib/compositor/wiredLayer'

const EPS = 1e-9
const same = (a: number, b: number) => Math.abs(a - b) < EPS
const sameMask = (a: LayerMask | undefined, b: LayerMask) =>
  !!a && a.kind === b.kind && same(a.x, b.x) && same(a.y, b.y) && same(a.w, b.w) && same(a.h, b.h)

export interface Target { cx: number; cy: number; w?: number; h?: number }

/**
 * Rewrite one layer for its resolved box (box px). `k` is the layoutScale the
 * painter will apply, so a size of T px is stored as T / (W·k). `kv` is its
 * vertical twin (s·H0/H) — only the cloner needs it, because its `dy` is a
 * fraction of the frame HEIGHT while every size field is a fraction of the width.
 * Position only when `w`/`h` are absent. Returns the SAME reference when nothing
 * changes.
 */
export function placeLayer(layer: LocalLayer, t: Target, W: number, H: number, k: number, ctx: CanvasRenderingContext2D | null, kv: number = k): LocalLayer {
  const x = t.cx / W, y = t.cy / H
  const unit = W * k
  const patch: Record<string, unknown> = {}
  if (!same(layer.x, x)) patch.x = x
  if (!same(layer.y, y)) patch.y = y
  if (t.w != null || t.h != null) stretchInto(layer, t, unit, W, x, y, patch)
  scaleCloner(layer, k, kv, patch)
  if (Object.keys(patch).length === 0) return layer
  return { ...layer, ...patch } as LocalLayer
}

/**
 * A cloner's stamp offsets ride on the LAYER's own coordinates — the painter draws
 * each stamp at `(layer.x + c.dx)·W`, `(layer.y + c.dy)·H`, neither of which passes
 * under the painter's layout scale `k` (that folds into the stamp's own scale, about
 * the stamp's centre). So the offsets have to be scaled here or the arrangement
 * spreads out with the box: `spacingX`/`nudgeX`/`radius` are width fractions (× k),
 * `spacingY`/`nudgeY` height fractions (× kv). `radius` needs no vertical twin — the
 * painter passes `aspect = W/H` into expandClones, which makes the radial `dy` a
 * width fraction in disguise (`radius·(W/H)·sin·H = radius·sin·W`). `staggerX`/`Y`
 * are multipliers OF the spacings, so they scale with them and must stay put.
 */
function scaleCloner(layer: LocalLayer, k: number, kv: number, patch: Record<string, unknown>) {
  const c = layer.cloner
  if (!c?.enabled) return
  if (same(k, 1) && same(kv, 1)) return
  const mul = (v: number | undefined, f: number) => (typeof v === 'number' ? v * f : v)
  patch.cloner = {
    ...c,
    spacingX: mul(c.spacingX, k), nudgeX: mul(c.nudgeX, k), radius: mul(c.radius, k),
    spacingY: mul(c.spacingY, kv), nudgeY: mul(c.nudgeY, kv),
  } as Cloner
}

// `cx`/`cy` = the layer's resolved centre in the box's normalized space: a crop mask
// (`LayerMask`) is stored in CANVAS space, so a cover-and-crop mask is centred there.
// The mask's `w`/`h` are canvas fractions (`T / W`) while every size field above is in
// painter units (`T / (W·k)`), because paintLayerCropped applies the mask via
// applyMaskClip in CANVAS space BEFORE paintLayer builds the per-layer transform — so
// the mask never passes under the painter's layout scale `k`, but the size fields do.
function stretchInto(layer: LocalLayer, t: Target, unit: number, W: number, cx: number, cy: number, patch: Record<string, unknown>) {
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
      // centred on the layer.
      // A degenerate box (w = 0) or a wired layer that has never seen content
      // (lastAspect 0/undefined — wiredLayerHeight defends it the same way) would
      // otherwise make `boxH / aspect` Infinity, so fall back to square.
      const h0 = layer.kind === 'image' ? (layer as ImageLayer).h : wiredLayerHeight(layer as WiredLayer)
      const aspect = layer.w > 0 && h0 > 0 ? h0 / layer.w : 1
      const boxW = tw ?? layer.w, boxH = th ?? layer.w * aspect
      const byW = { w: boxW, h: boxW * aspect }
      const cover = byW.h >= boxH - EPS ? byW : { w: boxH / aspect, h: boxH }
      if (!same(layer.w, cover.w)) patch.w = cover.w
      if (layer.kind === 'image' && !same((layer as ImageLayer).h, cover.h)) patch.h = cover.h
      const needsCrop = cover.w > boxW + EPS || cover.h > boxH + EPS
      if (needsCrop) {
        // Canvas fractions, NOT painter units (see the note above this function).
        const mask: LayerMask = { kind: 'rect', x: cx, y: cy, w: (t.w ?? boxW * unit) / W, h: (t.h ?? boxH * unit) / W }
        if (!sameMask(layer.mask, mask)) patch.mask = mask
      }
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
