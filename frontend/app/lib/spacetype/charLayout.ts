import * as THREE from 'three'
import { drawShape, shapeAspect } from '~/lib/shapes/path2d'
import type { LibraryShape } from '~/lib/shapes/catalog'
import type { SeparatorSpec } from './separator'

/**
 * Per-character layout for the per-glyph Space Type effects (cylinder, …).
 *
 * The WHOLE text is rendered to ONE offscreen canvas (a single row), exactly the
 * way makeTextTexture renders a ribbon tile (same font string, fontVariationSettings,
 * letterSpacing, horizontal scaleX, fill + optional stroke). While laying it out we
 * record each non-space glyph's pixel x-range, so each glyph can be sampled from the
 * shared CanvasTexture by its UV region [u0,u1]×[0,1] and placed as its own quad.
 *
 * Spaces don't emit a glyph but DO advance the cumulative position so the text
 * spreads (and `centerT` spaces out) correctly.
 */
export interface CharGlyph {
  char: string
  u0: number       // left edge of the glyph in texture UV (0..1)
  u1: number       // right edge of the glyph in texture UV (0..1)
  aspect: number   // glyph width / row height (used to size the quad)
  centerT: number  // 0..1 position of the glyph centre along the whole text (path placement)
}

export interface CharLayout {
  texture: THREE.CanvasTexture
  glyphs: CharGlyph[]
  lineHeightPx: number
}

export interface CharLayoutOpts {
  text: string
  fontFamily: string
  fontWeight: number
  fontSizePx: number
  tracking: number       // px letter-spacing (Tracking)
  scaleX: number         // horizontal glyph scale (Type X-Scale); 1 ⇒ no stretch
  color: string
  strokeColor?: string
  strokeWidth?: number
  // Full variable-font axes (e.g. { wght: 700, wdth: 80, slnt: -10 }). When given, drives
  // fontVariationSettings; otherwise just weight. Non-weight axes need Chromium.
  axes?: Record<string, number>
  /** Shape painted as one extra glyph after the last letter — see separator.ts. */
  separator?: SeparatorSpec
}

/** Apply font + variation + letterSpacing to a 2D context (mirrors makeTextTexture). */
function applyFont(
  ctx: CanvasRenderingContext2D,
  font: string,
  fontWeight: number,
  tracking: number,
  axes?: Record<string, number>,
): void {
  ctx.font = font
  const variation = axes && Object.keys(axes).length
    ? Object.entries(axes).map(([t, v]) => `"${t}" ${v}`).join(', ')
    : `"wght" ${fontWeight}`
  if ('fontVariationSettings' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { fontVariationSettings: string }).fontVariationSettings = variation
  }
  if ('letterSpacing' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${tracking}px`
  }
}

export function layoutChars(opts: CharLayoutOpts): CharLayout {
  const lineHeightPx = Math.max(2, Math.round(opts.fontSizePx))
  const fontPx = Math.round(lineHeightPx * 0.7)
  const tracking = opts.tracking ?? 0
  // Same scaleX trick as makeTextTexture: measure at scaleX=1, widen the canvas,
  // then ctx.scale(scaleX,1) before drawing so the glyphs fill the widened canvas.
  const scaleX = Math.max(0.01, opts.scaleX ?? 1)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${opts.fontWeight} ${fontPx}px "${opts.fontFamily}", sans-serif`

  // ── Measure pass (unscaled). Walk the string char-by-char, recording each
  //    non-space glyph's x-start + width via cumulative measureText. measureText
  //    of a single char does NOT include the trailing letter-spacing, so we add
  //    `tracking` between successive chars ourselves to match the drawn advance.
  applyFont(ctx, font, opts.fontWeight, tracking, opts.axes)
  const chars = Array.from(opts.text)
  let cursor = 0 // unscaled px advance so far
  const measured: { char: string; x: number; w: number; isSpace: boolean; shape?: LibraryShape; shapeH?: number }[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const w = ctx.measureText(ch).width
    measured.push({ char: ch, x: cursor, w, isSpace: ch.trim() === '' })
    cursor += w
    if (i < chars.length - 1) cursor += tracking // inter-char letter-spacing
  }

  // Separator: one more cell after the last letter — [gap][shape][gap] — so a ring that
  // wraps the word once reads "WORD ✦" at its seam. Same numbers as the tile painter.
  const sep = opts.separator
  if (sep) {
    const gapPx = sep.gap * fontPx * 0.25
    const cap = ctx.measureText('H').actualBoundingBoxAscent || fontPx * 0.72
    const shapeH = Math.min(cap * sep.size, lineHeightPx)
    const shapeW = shapeH * shapeAspect(sep.shape)
    cursor += gapPx
    measured.push({ char: sep.shape.id, x: cursor, w: shapeW, isSpace: false, shape: sep.shape, shapeH })
    cursor += shapeW + gapPx
  }

  const totalAdvance = Math.max(1, cursor) // unscaled total width (excl. trailing tracking)

  // Canvas width = widened total advance; height = row height.
  const w = Math.max(2, Math.ceil(totalAdvance * scaleX))
  const h = lineHeightPx
  canvas.width = w
  canvas.height = h
  ctx.clearRect(0, 0, w, h)

  // ── Draw pass (scaled). Apply horizontal scale around the origin; all draws use
  //    unscaled coords (totalAdvance space) and get stretched into the widened canvas.
  //    CRITICAL: draw each glyph at its OWN measured x (`m.x`), NOT the whole string in
  //    one fillText. A bulk fillText applies kerning + letter-spacing distribution that
  //    the per-char measure pass doesn't, so the painted pixels drift from the per-glyph
  //    UV windows (u0/u1) — which, in the per-character cylinder, clips each glyph in
  //    half as Tracking grows. Painting each glyph at m.x makes pixels == UV exactly.
  //    letterSpacing is zeroed here: inter-glyph spacing already lives in m.x.
  ctx.setTransform(scaleX, 0, 0, 1, 0, 0)
  applyFont(ctx, font, opts.fontWeight, 0, opts.axes)
  ctx.fillStyle = opts.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const stroke = (opts.strokeWidth ?? 0) > 0
  if (stroke) {
    ctx.lineWidth = opts.strokeWidth as number
    ctx.strokeStyle = opts.strokeColor ?? '#000000'
    ctx.lineJoin = 'round'
  }
  for (const m of measured) {
    if (m.isSpace) continue
    if (m.shape) {
      drawShape(ctx, m.shape, {
        x: m.x, y: h / 2 - (m.shapeH ?? 0) / 2, w: m.w, h: m.shapeH ?? 0,
        fill: opts.color,
        stroke: stroke ? { color: opts.strokeColor ?? '#000000', width: opts.strokeWidth as number } : undefined,
      })
      continue
    }
    if (stroke) ctx.strokeText(m.char, m.x, h / 2)
    ctx.fillText(m.char, m.x, h / 2)
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // ── Build per-glyph UV regions. x-positions were measured unscaled, so they map
  //    into the scaled canvas by multiplying by scaleX (canvas width = totalAdvance*scaleX),
  //    i.e. u = x / totalAdvance directly. centerT is normalized to the unscaled total.
  const glyphs: CharGlyph[] = []
  for (const m of measured) {
    if (m.isSpace) continue // spaces advance the cursor but emit no quad
    const u0 = m.x / totalAdvance
    const u1 = (m.x + m.w) / totalAdvance
    glyphs.push({
      char: m.char,
      u0,
      u1,
      aspect: m.w / lineHeightPx,
      centerT: (m.x + m.w / 2) / totalAdvance,
    })
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 4
  tex.needsUpdate = true

  return { texture: tex, glyphs, lineHeightPx }
}
