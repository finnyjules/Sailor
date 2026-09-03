/**
 * The 2D paint resolver — turn a `Paint` (colour string | Gradient | Fill) into
 * something assignable to `ctx.fillStyle`/`ctx.strokeStyle`.
 *
 * Lifted VERBATIM out of `composables/useCompositorLayers.ts`, where these four
 * functions were module-private, so a second studio (Vector Type) can use the
 * same resolver instead of growing a near-copy. The only change from the
 * original is that the module-level `_fieldCtx` frame state is now an EXPLICIT
 * `field` parameter (see `ShaderFieldFrameCtx` below) — a hidden module global
 * was defensible with exactly one host that set it up; with two it would be a
 * cross-host coupling bug waiting to happen. Each host keeps (and mutates) its
 * own frame state and threads it in at the call site.
 *
 * ORIGIN CONVENTION: gradients and patterns here are built CENTRED on the
 * origin — the box `{ w, h }` maps to `[-w/2..w/2] × [-h/2..h/2]` — because the
 * Compositor draws every primitive centred at its own origin. This is
 * deliberately DIFFERENT from `paintTileBox` in `~/lib/compositor/paint.ts`,
 * which is corner-origin (`[0,0]..[w,h]`); see its doc at paint.ts:44-52. Do not
 * harmonise the two: callers pick the one matching their drawing convention.
 */
import { type Fill, type ShaderSpec, fillTileBox, fillIsShader } from '~/lib/spacetype/fillTile'
import { resolveField } from '~/lib/shaderfill/field'
import { type Paint, type ImageFill, isGradient, isFill, isImageFill, imageFillRect } from '~/lib/compositor/paint'
import { getFillBitmap } from '~/lib/paint/imageFillCache'
// What the SVG export makes of a paint — the ORACLE for `spread: 'extend'` (see
// `PaintSpread` and `fillSpreadKind` below). Import edge runs one way only:
// `toVector` imports the spine, the paint model and `fillTile`, and imports
// nothing from here, so this is not a cycle.
import { exportTier } from '~/lib/paint/toVector'
// One definition of what a gradient ANGLE means, shared with the SVG spine (and
// with `fillTileBox`) so the exported paint server is the same geometry as the
// canvas gradient rather than a second derivation of it.
import { gradientUnitAxis } from '~/lib/vector/svg'

/**
 * How far a paint is allowed to reach.
 *
 *  - `'box'` — the paint exists ONLY inside `box`, and paints nothing outside
 *    it. This is what this resolver has always done, and it is the DEFAULT, so
 *    every existing caller (the Compositor, Space Type's frame modal, every
 *    Vector Type layer with no reach) is byte-identical to before this option
 *    existed. Correct whenever the ink being painted IS the box.
 *  - `'extend'` — the ink reaches OUTSIDE its own paint box, and the paint has
 *    to follow it there. A caller asks for this when it knows its geometry
 *    overspills the box it anchored the paint to: an extrude's offset copies, a
 *    stroke's outer half. Under `'box'` those pixels come out EMPTY — the bug
 *    this option exists to fix, measured at 68 % of an extrude's ink and 47 % of
 *    a 20 px stroke's.
 *
 * `'extend'` never changes the picture INSIDE the box; it only says what happens
 * beyond its edge. `box` still means exactly what it meant — the ramp/lattice is
 * still mapped onto it — which is what keeps the canvas agreeing with the SVG
 * about COLOUR as well as about coverage. (Widening the box instead would fix
 * the coverage and break the colour everywhere; see this module's twin,
 * `toVector.ts`, for what the export actually anchors to.)
 */
export type PaintSpread = 'box' | 'extend'

/**
 * WHAT a fill does outside its box under `'extend'` — and the answer is taken
 * from the SVG export, which is the more correct picture of the two and the one
 * this canvas is measured against.
 *
 *  - `'pad'` — the export is a `<linearGradient>`/`<radialGradient>`, and SVG
 *    paint servers pad (`spreadMethod="pad"` is the default): the end stops
 *    extend forever. Only `gradient` reaches here; `solid` short-circuits before
 *    any of this.
 *  - `'repeat'` — the export is a `<pattern>`, and a `<pattern>` TILES. That
 *    covers the four procedural fills (`grid`, `checkerboard`, `stripes`, `qr`),
 *    which export as real tiled geometry, AND `ombre`/`noise`/`shader`, which
 *    export as a `<pattern>` holding one box-sized `<image>` — also tiled. (The
 *    original recipe for this fix guessed `'pad'` for those last two on the
 *    grounds that they are "continuous"; the export says otherwise, and the
 *    export is the oracle. It is also the better picture: an edge-clamped noise
 *    field draws streaks out of its last pixel row, where a tiled one just keeps
 *    being noise.)
 *
 * DERIVED, NOT TABULATED — `exportTier` is asked, so a tenth fill type, or an
 * existing one taught a vector form, moves with the exporter instead of waiting
 * for someone to remember this list. Memoised on the fill TYPE, which is the
 * only field `exportTier` can discriminate on for these purposes, because this
 * runs once per glyph inside a draw loop.
 */
const _spreadKind = new Map<string, 'pad' | 'repeat'>()
export function fillSpreadKind(fill: Fill): 'pad' | 'repeat' {
  const hit = _spreadKind.get(fill.type)
  if (hit) return hit
  const kind = exportTier(fill) === 'vector' ? 'pad' : 'repeat'
  _spreadKind.set(fill.type, kind)
  return kind
}

export function hasPaint(paint: Paint | undefined): boolean {
  if (isImageFill(paint)) return !!paint.src
  if (isFill(paint)) return true                        // a fill always paints (solid → fill.a)
  if (isGradient(paint)) return paint.stops.length > 0
  return !!paint && paint !== 'none' && paint !== 'transparent'
}

/**
 * Resolve a Paint to a canvas fillStyle. Solid colors pass through; gradients
 * are built against a local box `{ w, h }` (in the CURRENT drawing units, i.e.
 * pixels for rect/ellipse, local width-fraction units for paths) centered on
 * origin, so the gradient tracks the shape under any transform.
 */
export function resolvePaint(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  box: { w: number; h: number },
  field: ShaderFieldFrameCtx,
  /** See `PaintSpread`. Defaults to today's behaviour. A `Gradient` ignores it —
   *  a real `CanvasGradient` already pads, which is why the clipping bug was
   *  only ever reachable through the `Fill` arm. */
  spread: PaintSpread = 'box',
): string | CanvasGradient | CanvasPattern {
  if (isImageFill(paint)) return resolveImageFill(ctx, paint, box)
  if (isFill(paint)) return resolveFill(ctx, paint, box, field, spread)
  if (!isGradient(paint)) return paint
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset)
  let g: CanvasGradient
  if (paint.type === 'radial') {
    const r = Math.max(box.w, box.h) / 2
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(r, 0.0001))
  } else {
    // CENTRED origin (this module's convention, see the header): the unit axis
    // shifted so the box's centre is the origin. Identical arithmetic to the
    // `±cos·w/2` it replaces; the point is that the number now comes from the
    // one definition the SVG writer also uses.
    const ax = gradientUnitAxis(paint.angle ?? 0)
    g = ctx.createLinearGradient((ax.x1 - 0.5) * box.w, (ax.y1 - 0.5) * box.h, (ax.x2 - 0.5) * box.w, (ax.y2 - 0.5) * box.h)
  }
  for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color)
  return g
}

/** An `ImageFill` → a `CanvasPattern` (centered-origin, this module's convention).
 *  cover/contain/stretch paint one box-sized tile; tile repeats a cell whose width
 *  spans `scale` of the box. Returns 'transparent' until the bitmap is cached. */
function resolveImageFill(
  ctx: CanvasRenderingContext2D,
  paint: ImageFill,
  box: { w: number; h: number },
): string | CanvasPattern {
  const img = getFillBitmap(paint.src)
  const iw = img ? (img.naturalWidth || img.width) : 0
  const ih = img ? (img.naturalHeight || img.height) : 0
  if (!img || !iw || !ih) return 'transparent'
  const bw = Math.max(box.w, 1e-3), bh = Math.max(box.h, 1e-3)
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  const sx = m ? (Math.hypot(m.a, m.b) || 1) : 1, sy = m ? (Math.hypot(m.c, m.d) || 1) : 1
  const k = Math.min(1, FILL_TILE_CAP / Math.max(bw * sx, bh * sy, 1))
  const scale = paint.scale && paint.scale > 0 ? paint.scale : 1
  const offset = paint.offset ?? { x: 0, y: 0 }

  if (paint.fit === 'tile') {
    const cellW = Math.max(1, Math.round(bw * scale * sx * k))
    const cellH = Math.max(1, Math.round(cellW * (ih / iw)))
    const cell = document.createElement('canvas'); cell.width = cellW; cell.height = cellH
    cell.getContext('2d')!.drawImage(img, 0, 0, cellW, cellH)
    const pat = ctx.createPattern(cell, 'repeat')
    if (!pat) return 'transparent'
    if (typeof DOMMatrix !== 'undefined' && pat.setTransform) {
      pat.setTransform(new DOMMatrix()
        .translateSelf(-bw / 2 + offset.x * bw, -bh / 2 + offset.y * bh)
        .scaleSelf(1 / (sx * k), 1 / (sy * k)))
    }
    return pat
  }

  const tw = Math.max(1, Math.round(bw * sx * k)), th = Math.max(1, Math.round(bh * sy * k))
  const tile = document.createElement('canvas'); tile.width = tw; tile.height = th
  const { dx, dy, dw, dh } = imageFillRect(paint.fit, iw, ih, tw, th, scale, offset)
  tile.getContext('2d')!.drawImage(img, dx, dy, dw, dh)
  const pat = ctx.createPattern(tile, 'no-repeat')
  if (!pat) return 'transparent'
  if (typeof DOMMatrix !== 'undefined' && pat.setTransform) {
    pat.setTransform(new DOMMatrix().translateSelf(-bw / 2, -bh / 2).scaleSelf(bw / tw, bh / th))
  }
  return pat
}

// A Type-Studio Fill → a 2D pattern that spans the shape's box ONCE (drawing is
// centered, so the tile maps onto [-w/2..w/2] × [-h/2..h/2]). The tile is built at
// the box's ACTUAL on-screen pixel size (read from the ctx transform, capped) so it
// stays crisp, and patterns use square cells so they never stretch on a non-square
// shape. `solid` short-circuits to the flat colour. `shader` NEVER reaches this tile
// cache — see resolveShaderFill below, which routes to the (time-aware) field cache
// instead, keyed by `fillIsShader` before any of this runs.
const FILL_TILE_CAP = 1024
const _fillTileCache = new Map<string, HTMLCanvasElement>()
function fillTileCached(fill: Fill, tw: number, th: number): HTMLCanvasElement {
  // shapeId only matters for `shapes`; fold it in so switching the shape (same colours/density/
  // angle/size) doesn't return the previously cached tile of a different shape.
  const key = `${fill.type}|${fill.a}|${fill.b}|${fill.angle}|${fill.density}|${tw}x${th}|${fill.type === 'shapes' ? (fill.shapeId ?? 'sparkle') : ''}`
  let t = _fillTileCache.get(key)
  if (!t) {
    t = fillTileBox(fill, tw, th)
    if (_fillTileCache.size > 64) _fillTileCache.clear()
    _fillTileCache.set(key, t)
  }
  return t
}

// ── Shader fills on frame primitives (Task 6) ────────────────────────────────────
// The host is its OWN shader-fill host: `withFieldFrame`'s live-field ceiling
// (see ~/lib/shaderfill/field.ts) and the frozen-field count it returns must be that
// frame's own, never pooled with an open Space Type/Shape Studio node — those are a
// DIFFERENT host with their own per-owner call in ~/lib/spacetype/fills.ts's
// refreshLiveShaderFills (Task 4's `withShaderFillContext` scheme). The Compositor's
// `paintLayerStack` is the ONE place that calls `withFieldFrame` for its frame, once
// per synchronous pass, with every shader fill this frame's own layers + background
// actually carry — so as long as it never awaits mid-pass (it doesn't), no other
// host's span can land between it and the resolveField calls that consume its
// `liveKeys`.
//
// `field.base` is "the ctx transform in effect BEFORE the current primitive's own
// local placement (translate/rotate/shear/scale) was applied" — i.e. the frame's own
// base transform. It's re-captured right before every `applyXform` call (both the
// fast path and the effects offscreen path) and before the background's own center
// translate, so it's always correct for whichever primitive resolveFill is about to
// paint, regardless of which canvas (`ctx` or a fresh effects offscreen) that is.
// A frame-anchored fill's pattern matrix is then `currentCTM⁻¹ · base`: composing the
// INVERSE of the primitive's own local transform against that captured base cancels
// exactly the part contributed by the shape's own position/rotation, leaving every
// primitive sampling the SAME field at the SAME frame-space location regardless of
// where the shape sits — the field stays put; the shape moves over it.
export interface ShaderFieldFrameCtx {
  frameW: number; frameH: number; t: number; fps: number; base: DOMMatrix | null; bake: boolean
  /** The `withFieldFrame` token for the span currently open — see `resolveField`'s doc in
   *  ~/lib/shaderfill/field.ts. Set once per host frame pass, right after
   *  `withFieldFrame` opens its span; `resolveShaderFill` (called deep inside the per-item
   *  draw loop, not at the `withFieldFrame` call site itself) reads it from here to pass
   *  into every `resolveField` call, the same way it already reads `t`/`fps`/`bake` from
   *  this struct rather than threading them as parameters through every intermediate call. */
  token: number
}

/** Object-anchor shader fields render at ONE fixed resolution and get STRETCHED into
 *  each shape's own box by the pattern's scale transform below — the same semantics as
 *  Space Type/Shape Studio's shaderFieldTexture (one texture per spec, reused by every
 *  material that shares it, fitted to each one's own UV box), not a per-shape render.
 *  Crucially this also keeps the paintLayerStack pre-pass trivial and impossible to
 *  desync from this function: neither depends on any shape's actual box size (which the
 *  pre-pass would otherwise have to duplicate exactly — box math differs subtly per
 *  layer kind, e.g. brush's dpr-scaled bounds crop — to avoid the pre-pass asking
 *  beginFieldFrame for a DIFFERENT key than this function resolves, which would silently
 *  freeze an in-budget fill; see the git history of this comment for that exact bug).
 *  This is the size we ASK resolveField for, not necessarily the size we GET: it clamps
 *  any live (non-bake) request to LIVE_FIELD_PX (512, ~/lib/shaderfill/field.ts) — so
 *  every scale computation below reads the RETURNED canvas's own `.width`/`.height`,
 *  never `fw`/`fh`. Getting that backwards (scaling by the request instead of the
 *  clamped result) was a real, shipped bug: the pattern only covered the top-left
 *  fraction of the box/frame that the clamp ratio implies, transparent beyond it —
 *  see the git history of this comment. */
export const OBJECT_SHADER_FIELD_PX = 1024

export function resolveShaderFill(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  spec: ShaderSpec,
  box: { w: number; h: number },
  field: ShaderFieldFrameCtx,
  spread: PaintSpread = 'box',
): string | CanvasGradient | CanvasPattern {
  const frame = spec.anchor === 'frame'
  const bw = Math.max(box.w, 1e-3), bh = Math.max(box.h, 1e-3)
  const fw = frame ? Math.max(1, Math.round(field.frameW)) : OBJECT_SHADER_FIELD_PX
  const fh = frame ? Math.max(1, Math.round(field.frameH)) : OBJECT_SHADER_FIELD_PX
  const canvas = resolveField({ spec, w: fw, h: fh, t: field.t, fps: field.fps, bake: field.bake }, field.token)
  // graceful: the shader's own input paint. spec.input is a Paint (string | Gradient |
  // Fill), not just a Fill — go through resolvePaint (the general Paint resolver), not
  // resolveFill (Fill-only), or a Gradient/string input would throw/misrender here.
  if (!canvas) return resolvePaint(ctx, spec.input, box, field, spread)
  // A shader exports as a `<pattern>` holding one box-sized `<image>`, which tiles —
  // so `'extend'` tiles too. The FRAME anchor is exempt: its box is the whole output
  // frame, so there is nothing outside it to paint, and repeating it would only give
  // a bake at a larger size a second copy of the field where it currently has none.
  const pat = ctx.createPattern(canvas, spread === 'extend' && !frame ? 'repeat' : 'no-repeat')
  if (!pat) return fill.a
  if (typeof DOMMatrix !== 'undefined' && pat.setTransform) {
    if (frame && field.base) {
      // ctx.getTransform().inverse() never throws — a singular (zero-scale) matrix
      // comes back as all-NaN, and setTransform silently no-ops on a non-finite
      // matrix (leaving the pattern unpositioned), so this degrades gracefully on
      // its own; the try/catch is just defensive, not load-bearing.
      try {
        // The field was very likely rendered SMALLER than the frame (resolveField's
        // live clamp) — canvas.width/height is the size we actually got, so an extra
        // scale-up by frameW/canvas.width (etc.) stretches it back across the full
        // frame instead of leaving it covering only a corner of it.
        pat.setTransform(
          ctx.getTransform().inverse().multiply(field.base)
            .scaleSelf(field.frameW / canvas.width, field.frameH / canvas.height),
        )
      } catch { /* see comment above — not expected to fire */ }
    } else {
      pat.setTransform(new DOMMatrix().translateSelf(-bw / 2, -bh / 2).scaleSelf(bw / canvas.width, bh / canvas.height))
    }
  }
  return pat
}

export function resolveFill(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  box: { w: number; h: number },
  field: ShaderFieldFrameCtx,
  /** See `PaintSpread`. `'box'` — the default — is byte-for-byte the behaviour
   *  this function has always had: ONE `no-repeat` tile, nothing outside it. */
  spread: PaintSpread = 'box',
): string | CanvasGradient | CanvasPattern {
  if (fill.type === 'solid') return fill.a
  if (fillIsShader(fill)) return resolveShaderFill(ctx, fill, fill.shader, box, field, spread)
  const bw = Math.max(box.w, 1e-3), bh = Math.max(box.h, 1e-3)
  // ── The padding arm ───────────────────────────────────────────────────────
  // A `gradient` Fill is the two-colour shorthand for a linear ramp, and the
  // canvas already owns a primitive that ramps over a segment and PADS beyond
  // it — which is exactly `spreadMethod="pad"`, exactly what the `<linearGradient>`
  // this fill exports as does, and exact rather than an approximation of it.
  // (The recipe for this fix proposed a margined tile with its 1 px edges
  // stretched outward. That is what you build when the only tool is a pattern;
  // it costs a second canvas, ~9× the tile pixels, and a margin guess that is
  // wrong the moment the reach exceeds it. `createLinearGradient` has no margin
  // to guess and no edge to stretch.)
  //
  // The segment is `resolvePaint`'s own `Gradient` arithmetic — the SAME unit
  // axis, mapped onto the SAME centred box — so the ramp lands on the same
  // pixels the tile put it on; only what happens past the box's edge changes.
  if (spread === 'extend' && fillSpreadKind(fill) === 'pad') {
    const ax = gradientUnitAxis(fill.angle)
    const g = ctx.createLinearGradient(
      (ax.x1 - 0.5) * bw, (ax.y1 - 0.5) * bh,
      (ax.x2 - 0.5) * bw, (ax.y2 - 0.5) * bh,
    )
    g.addColorStop(0, fill.a)
    g.addColorStop(1, fill.b)
    return g
  }
  // Effective on-screen pixel extent of the box under the current transform.
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  const sx = m ? (Math.hypot(m.a, m.b) || 1) : 1, sy = m ? (Math.hypot(m.c, m.d) || 1) : 1
  const k = Math.min(1, FILL_TILE_CAP / Math.max(bw * sx, bh * sy, 1))
  const tw = Math.max(1, Math.round(bw * sx * k)), th = Math.max(1, Math.round(bh * sy * k))
  const tile = fillTileCached(fill, tw, th)
  // The tiling arm. `'repeat'` continues the lattice/field past the box the way
  // the `<pattern>` this fill exports as does.
  //
  // EXACT for `qr`, `ombre`, `noise` and `shader`: the export's tile IS the box
  // (one box-sized `<image>` or one box-sized cell grid), and so is this one.
  //
  // APPROXIMATE for `grid` / `checkerboard` / `stripes`, whose export tiles a
  // SMALLER unit (`cell`, `2·cell`, `2·cell` rotated). Horizontally the box is a
  // whole number of cells by construction (`fillPatternCell` is `W / density`),
  // so the lattice continues cleanly along the axis the box is measured on;
  // vertically, and for a rotated stripe, the box edge is a phase seam. Measured
  // against the SVG: coverage is identical, and the per-pixel colour difference
  // outside the box is the same KIND of sub-pixel lattice disagreement these
  // three already show INSIDE it (a no-reach `stripes` fill differs from its own
  // export on 27 % of glyph pixels today), just more of it. Closing that gap
  // means emitting the export's own tile plus its rotation here, which is a
  // second renderer of the same lattice — the drift this codebase keeps paying
  // for. Not worth it to fix a seam; very much worth it to stop losing 68 % of
  // the ink.
  const pat = ctx.createPattern(tile, spread === 'extend' ? 'repeat' : 'no-repeat')
  if (!pat) return fill.a
  if (typeof DOMMatrix !== 'undefined' && pat.setTransform) {
    pat.setTransform(new DOMMatrix().translateSelf(-bw / 2, -bh / 2).scaleSelf(bw / tw, bh / th))
  }
  return pat
}
