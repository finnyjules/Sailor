import * as THREE from 'three'
import { makeGradientTexture, type GradientStop } from './gradient'
import type { SeparatorSpec } from './separator'
import { drawShape, shapeAspect } from '~/lib/shapes/path2d'

export interface TextTextureOptions {
  label: string                 // already includes the trailing gap (buildRibbonLabel)
  labels?: string[]             // multiple texts → N-row atlas the effect alternates between
  fontFamily: string
  fontWeight: number
  axes: Record<string, number>  // variable-font axes, e.g. { wght: 700 }
  typeColor: string
  /** Texture pixel height; width is derived to fit ONE tile of the label. */
  heightPx?: number
  fontSizePx?: number
  scaleX?: number        // horizontal glyph scale (TYPE X-Scale); 1 ⇒ no stretch
  tracking?: number      // px letter-spacing (Tracking)
  strokeColor?: string   // outline color
  strokeWidth?: number   // px outline width (Type Stroke); 0 ⇒ no stroke
  gradientStops?: GradientStop[]
  gradientOn?: boolean
  uRepeat?: number
  /** Shape painted between word repeats — see separator.ts. Undefined ⇒ byte-identical tile to before. */
  separator?: SeparatorSpec
}

/** Format axes as a CSS font-variation-settings value. Pure + unit-tested. */
export function axesToVariation(axes: Record<string, number>): string {
  const parts = Object.entries(axes).map(([tag, v]) => `"${tag}" ${v}`)
  return parts.join(', ')
}

/**
 * Render ONE tile of the label to a transparent canvas and return a repeating
 * THREE.CanvasTexture. The ribbon geometry repeats this texture along its
 * length; scrolling is done by offsetting texture.offset.x in the effect.
 */
export function makeTextTexture(opts: TextTextureOptions): THREE.CanvasTexture {
  const rowH = opts.heightPx ?? 256
  const fontPx = opts.fontSizePx ?? Math.round(rowH * 0.7)
  const tracking = opts.tracking ?? 0
  // TYPE X-Scale: stretch glyphs horizontally. We measure at scaleX=1, widen the
  // canvas by scaleX, then ctx.scale(scaleX, 1) before drawing so the text fills it.
  const scaleX = Math.max(0.01, opts.scaleX ?? 1)
  // One row per text; effects ALTERNATE rows per word-repeat. A single text ⇒ 1 row
  // (identical to the original behaviour). All rows share the canvas width (the widest).
  const labels = (opts.labels && opts.labels.length ? opts.labels : [opts.label])
    .map(l => (l && l.length ? l : ' '))
  const n = labels.length

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${opts.fontWeight} ${fontPx}px "${opts.fontFamily}", sans-serif`
  const variation = axesToVariation(opts.axes)
  const applyFont = () => {
    ctx.font = font
    if (variation && 'fontVariationSettings' in ctx) {
      ;(ctx as CanvasRenderingContext2D & { fontVariationSettings: string }).fontVariationSettings = variation
    }
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${tracking}px`
  }

  applyFont()
  const sep = opts.separator
  // Per-row TEXT width. With a separator the trailing gap that buildRibbonLabel
  // appends is discarded — the tile becomes [text][gap][shape][gap] and the gap
  // is the separator's own. Without one, the label (gap included) is measured
  // exactly as before, so the old tile is byte-identical.
  const textWidths = labels.map(l => Math.max(1, ctx.measureText(sep ? l.trimEnd() : l).width))
  let shapeW = 0, shapeH = 0, gapPx = 0
  if (sep) {
    const m = ctx.measureText((labels[0] ?? ' ').trimEnd())
    const cap = (m as TextMetrics).actualBoundingBoxAscent || fontPx * 0.72
    // Rows share one canvas with no per-row clip, so a shape taller than a row
    // would bleed into its neighbour — clamp it to the row height.
    shapeH = Math.min(cap * sep.size, rowH)
    shapeW = shapeH * shapeAspect(sep.shape)
    gapPx = sep.gap * fontPx * 0.25
  }
  const sepExtra = sep ? gapPx * 2 + shapeW : 0
  const widths = textWidths.map(w => w + sepExtra)
  const maxLabelW = Math.max(...widths, 1)
  // Natural (untracked) width of the first label ÷ its tracked width. Tiling effects use this to
  // treat Tracking as pure letter-spacing instead of a horizontal squeeze: because the whole word
  // texture is force-fit to a fixed tile, widening it via Tracking otherwise just compresses the
  // glyphs. Scaling the tile count by this ratio holds the glyph width constant (see stripes.ts
  // span mode). 1 when letterSpacing is unsupported or tracking is 0.
  let naturalWidthFrac = 1
  if ('letterSpacing' in ctx) {
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing: string }
    const savedLS = lsCtx.letterSpacing
    lsCtx.letterSpacing = '0px'
    const untracked = Math.max(1, ctx.measureText(sep ? (labels[0] ?? ' ').trimEnd() : (labels[0] ?? ' ')).width)
    lsCtx.letterSpacing = savedLS
    naturalWidthFrac = untracked / (sep ? textWidths[0]! : widths[0]!)
  }
  const measured = Math.max(2, Math.ceil(maxLabelW))
  const w = Math.max(2, Math.ceil(measured * scaleX))
  // Per-row width fraction (each text's width ÷ the widest), so effects can size their
  // per-text region/segment proportionally to the text length.
  const wordFracs = widths.map(x => x / maxLabelW)
  // Word INK fraction: visible content ÷ its tile. With a separator the ink runs
  // from the first letter through the shape (one leading gap included, the
  // trailing one excluded) so an effect that centres a repeat centres the unit.
  const wordInkFracs = labels.map((l, k) => {
    const ink = sep ? textWidths[k]! + gapPx + shapeW : Math.max(1, ctx.measureText(l.trimEnd()).width)
    return Math.min(1, ink / widths[k]!)
  })
  // Vertical ink box of the FIRST label (glyph top/bottom, not the whole row) — lets an effect
  // fit/centre the actual letters rather than the full tile. MUST measure with the SAME baseline
  // the glyph is drawn at (middle), or actualBoundingBox* is relative to the alphabetic baseline
  // and the box is offset (clips letters with ascenders/caps). Metrics may be unsupported → fall
  // back to typical cap proportions.
  ctx.textBaseline = 'middle'
  const m0 = ctx.measureText((labels[0] ?? ' ').trimEnd())
  const asc0 = (m0 as TextMetrics).actualBoundingBoxAscent || fontPx * 0.36
  const desc0 = (m0 as TextMetrics).actualBoundingBoxDescent || fontPx * 0.04
  const cy0 = (n - 1) * rowH + rowH / 2   // canvas-y where row 0 is drawn (textBaseline 'middle')
  const totalH0 = rowH * n
  const inkHeightFrac = Math.min(1, (asc0 + desc0) / totalH0)
  const inkVMid = 1 - (cy0 + (desc0 - asc0) / 2) / totalH0   // v (flipY) of the ink's vertical centre

  canvas.width = w
  canvas.height = rowH * n
  ctx.clearRect(0, 0, w, canvas.height)
  ctx.fillStyle = opts.typeColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // Draw text k at the BOTTOM-up row so that, under the default flipY, texture
  // V ∈ [k/n, (k+1)/n] samples text k (row 0 lowest). Effects select a row by
  // mapping their across-band v into that range.
  labels.forEach((label, k) => {
    const cy = (n - 1 - k) * rowH + rowH / 2
    const drawn = sep ? label.trimEnd() : label
    ctx.setTransform(scaleX, 0, 0, 1, 0, 0)
    applyFont()
    if ((opts.strokeWidth ?? 0) > 0) {
      ctx.lineWidth = opts.strokeWidth as number
      ctx.strokeStyle = opts.strokeColor ?? '#000000'
      ctx.lineJoin = 'round'
      ctx.strokeText(drawn, 0, cy)
    }
    ctx.fillText(drawn, 0, cy)
    if (sep) {
      // Centre the shape on the text's ink midline (baseline 'middle' puts the em
      // box centre at cy; the measured cap/descender pair shifts it to the letters).
      // asc0/desc0 and shapeH are row-0 metrics ON PURPOSE (matching inkVMid/
      // inkHeightFrac below): the separator holds one size and one line across
      // every row of a multi-text atlas rather than resizing per row.
      const mid = cy + (desc0 - asc0) / 2
      drawShape(ctx, sep.shape, {
        x: textWidths[k]! + gapPx, y: mid - shapeH / 2, w: shapeW, h: shapeH,
        fill: opts.typeColor,
        stroke: (opts.strokeWidth ?? 0) > 0 ? { color: opts.strokeColor ?? '#000000', width: opts.strokeWidth as number } : undefined,
      })
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  })

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 4
  tex.needsUpdate = true
  tex.userData.uRepeat = opts.uRepeat ?? 1
  tex.userData.numTexts = n
  tex.userData.wordFracs = wordFracs
  tex.userData.wordInkFracs = wordInkFracs
  tex.userData.inkHeightFrac = inkHeightFrac
  tex.userData.inkVMid = inkVMid
  tex.userData.naturalWidthFrac = naturalWidthFrac
  tex.userData.gradient = (opts.gradientOn && opts.gradientStops && opts.gradientStops.some(s => s.on))
    ? makeGradientTexture(opts.gradientStops, opts.typeColor)
    : undefined
  return tex
}
