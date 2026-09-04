/**
 * geoshape render orchestration — the ONE pipeline that turns a
 * `GeoShapeConfig` into `VectorShape[]`, an SVG string, or pixels on a
 * canvas.
 *
 * `renderShapes` is the pipeline every consumer (preview, bake, SVG export)
 * must go through, for the same reason `vectortype/render.ts`'s header gives:
 * three surfaces each growing their own copy of "shape -> geometry" is drift
 * that no single render can reveal.
 *
 * `baseShapePath` (Task 1) -> `arrange` (Task 3) -> `resolvePaint` (Task 5,
 * applies `invert`'s colour swap) -> `composite` (Task 4, folds the placed
 * clones and paints with the RESOLVED colours). `resolvePaint` is called here
 * rather than inside `composite` because `composite` already reads its paint
 * straight off `cfg.fill`/`cfg.stroke`/`cfg.overlapFill` — this is the one
 * seam where the config handed to it is the POST-invert config, not the raw
 * one a caller stored.
 *
 * Only the colour-swap form of `invert` is applied. A geometric knockout
 * (e.g. painting the negative space of the mark against a filled background)
 * is a different feature — `paint.ts`'s header already scopes it out for the
 * identical reason — and is left for a future task.
 */
import type { VectorShape, VectorPaint, VectorCommand } from '~/lib/vector/svg'
import { commandsToPathData, shapesToSVG, transformCommands, type SvgDocOptions } from '~/lib/vector/svg'
import { baseShapePath } from './shapes'
import { arrange } from './arrange'
import { composite, overlapFaces } from './boolean'
import { resolvePaint } from './paint'
import { prepareBlend, rotatePathD } from '~/lib/vector/morph'
import type { GeoShapeConfig } from './config'
import type { GeoStudioDoc, GeoLayer } from './studio'
import { isFill, isImageFill, type Paint } from '~/lib/compositor/paint'
import { paintToVectorPaint } from '~/lib/paint/toVector'
// The COMPOSITOR canvas resolver — NOT geoshape/paint.ts's `resolvePaint` (the
// invert helper, imported above and used for `renderShapes`'s colour-swap
// step). Aliased to avoid shadowing it; see this module's two very differently
// shaped `resolvePaint`s in the geoshape Task 2 brief.
import { resolvePaint as resolvePaintCanvas, OBJECT_SHADER_FIELD_PX, type ShaderFieldFrameCtx } from '~/lib/paint/resolve'
// Task 4 — image/shader warm pass. `ensureFillBitmaps` mirrors the Compositor's
// `ensureLayerImages` (useCompositorLayers.ts:596-611, which calls it directly);
// `withFieldFrame`/`resolveField` mirror `paintLayerStack`'s shader-fill pre-pass
// (useCompositorLayers.ts:1648-1681) — see `warmPaints`'s own doc below for the
// one deliberate difference (this host awaits the effect catalog first).
import { fillIsShader, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { ensureFillBitmaps } from '~/lib/paint/imageFillCache'
import { withFieldFrame, resolveField, type FieldRequest } from '~/lib/shaderfill/field'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'

/**
 * A `VectorShape` that also carries the AUTHORED `Paint` (gradient/pattern/
 * image/shader), not just the solid-string fallback `.fill` every reader
 * already understands. `boolean.ts`'s `composite` is the one producer; `toSvg`
 * consumes `.paint` to emit a real paint server, and `drawToCanvas` consumes it
 * to resolve a canvas fillStyle. `.fill` stays a plain solid-or-null fallback
 * for any reader that doesn't know about `.paint`.
 */
export type GeoVectorShape = VectorShape & {
  paint?: Paint
  /** The authored `Paint` an outline is drawn in when it is not a solid
   *  (per-clone/pieces outline or both, single-mode outline of a gradient
   *  fill). `stroke` then holds a solid fallback for `.paint`-unaware readers,
   *  exactly as `fill` does for `paint`. */
  strokePaint?: Paint
}

/**
 * `GeoShapeConfig` -> the final composed mark, as paintable `VectorShape[]`
 * in document space (origin-centred, same convention `composite` already
 * builds in — see `boolean.ts`'s header).
 */
export async function renderShapes(cfg: GeoShapeConfig): Promise<VectorShape[]> {
  const baseD = baseShapePath(cfg.shape, {
    sides: cfg.sides,
    starInner: cfg.starInner,
    irregularSeed: cfg.irregularSeed,
    size: cfg.size,
    roundCorners: cfg.roundCorners,
    roundRadius: cfg.roundRadius,
    libraryShape: cfg.libraryShape,
  })
  const placements = arrange(cfg)
  const rp = resolvePaint(cfg)
  // The post-invert config `composite` actually paints with — it reads fill/
  // stroke/overlapFill straight off whatever `cfg` it is handed, so this is
  // the one place `invert` takes effect.
  const cfg2: GeoShapeConfig = { ...cfg, fill: rp.fill, stroke: rp.stroke, overlapFill: rp.overlapFill }
  if (cfg.layout !== 'blend') return composite(baseD, placements, cfg2)

  // Blend: every clone is its own in-between outline. Shape B reuses the base
  // shape vocabulary (its own kind/size/rounding) and is rotated before the
  // morph so the point correspondence sees the rotated target.
  const targetD = rotatePathD(baseShapePath(cfg.blendShape, {
    sides: cfg.blendSides,
    starInner: cfg.blendStarInner,
    irregularSeed: cfg.blendIrregularSeed,
    size: cfg.blendSize,
    roundCorners: cfg.roundCorners,
    roundRadius: cfg.roundRadius,
    libraryShape: cfg.blendLibraryShape,
  }), cfg.blendRotate)
  // Prepare ONCE: the parse / skeleton check / flatten / resample / align does not
  // depend on the step, so a 200-step blend pays for it once instead of 200 times.
  const step = prepareBlend(baseD, targetD, { twist: cfg.blendTwist })
  const ds = placements.map((pl) => step(pl.blend ?? 0))
  return composite(ds, placements, cfg2)
}

/**
 * The bounding box of `shapes`' actual path geometry (document space, same
 * origin-centred convention `composite` builds in) — every command's x/y
 * args, min and max. `arrange` pushes clones out by `radius`/`spacing`/etc.,
 * so this is frequently much bigger than `size + padding*2`: that static
 * formula was `toSvg`'s old (buggy) size source and cropped the mark.
 */
export function contentBounds(shapes: VectorShape[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    for (const c of s.commands) {
      const a = c.args
      for (let i = 0; i + 1 < a.length; i += 2) {
        const x = a[i]!, y = a[i + 1]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!Number.isFinite(minX)) { minX = minY = -1; maxX = maxY = 1 } // empty fallback
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

/**
 * The frame margin (document units) laid around the mark on every side — the
 * ONE definition shared by `toSvg`'s viewBox and `drawToCanvas`'s fit-to-box
 * scale, so the SVG download, the live preview, and the PNG bake all frame the
 * mark identically. Driven by `cfg.padding` (the "Padding" control):
 *   > 0  insets the mark (margin around it),
 *   = 0  fills the frame edge-to-edge on its tight axis,
 *   < 0  overscans — the mark grows past the frame and is cropped by the edges
 *        (how you fill the WHOLE canvas on both axes, not just the tight one).
 * Half the DRAWN outline width keeps an outline from being clipped at the edge
 * when padding is non-negative; it's a rounding term next to any real overscan.
 * "Drawn" matters: `boolean.ts`'s `styled` paints an outline/both shape at
 * `strokeWidth || 1`, so a strokeWidth of 0 still puts a 1-unit line on the
 * canvas — the same fallback is applied here or half of that hairline clips.
 * `paintTarget` is optional so a caller with only the two numbers (the layered
 * stack's `studioFramePad`, which folds the rule in per layer) still type-checks.
 */
export function framePad(cfg: Pick<GeoShapeConfig, 'padding' | 'strokeWidth'> & Partial<Pick<GeoShapeConfig, 'paintTarget'>>): number {
  return cfg.padding + drawnStrokeWidth(cfg.strokeWidth, cfg.paintTarget) / 2
}

/** The width an outline is actually drawn at — `styled`'s `strokeWidth || 1`
 *  fallback for the outline/both targets, 0 (no outline of its own) for fill. */
function drawnStrokeWidth(strokeWidth: number, paintTarget: GeoShapeConfig['paintTarget'] = 'fill'): number {
  return Math.max(strokeWidth, paintTarget !== 'fill' ? 1 : 0)
}

/** How far one axis of the mark may be grown when overscanning (negative pad):
 *  the padded extent is floored at this fraction of the raw extent, so extreme
 *  negative padding SATURATES (the mark caps at ~1/FLOOR × its fit size) instead
 *  of the box collapsing to zero and the scale exploding. Size-independent: the
 *  cap is relative to the mark, so it behaves the same for a tiny or huge mark. */
const OVERSCAN_FLOOR = 0.2

/** One axis's framed extent: the raw extent grown by `pad` on both sides,
 *  floored per `OVERSCAN_FLOOR` so negative `pad` can't drive it to/below zero.
 *  Shared by `fitScale` (preview/PNG) and `toSvg` (SVG) so all three frame the
 *  mark identically at any padding, positive or negative. */
function paddedExtent(dim: number, pad: number): number {
  const d = dim || 1
  return Math.max(d * OVERSCAN_FLOOR, d + pad * 2)
}

/**
 * Uniform scale that fits `bounds` grown by `pad` on every side into a `w`×`h`
 * box. Positive `pad` insets (fit — the tighter axis governs, nothing cropped);
 * `pad === 0` touches the tight axis; negative `pad` overscans, growing the mark
 * past the box so it crops to fill. Pure and DOM-free so it's unit-testable;
 * `drawToCanvas` layers the canvas translate/scale on top. `pad` is in the SAME
 * document units as `bounds` (see `framePad`).
 */
export function fitScale(bounds: { w: number; h: number }, w: number, h: number, pad: number): number {
  return Math.min(w / paddedExtent(bounds.w, pad), h / paddedExtent(bounds.h, pad))
}

/**
 * `GeoShapeConfig` -> a standalone SVG document, sized to fit the ACTUAL
 * rendered geometry plus `padding` on every side.
 *
 * The old formula sized the box from `cfg.size + cfg.padding*2` alone, but
 * `arrange` pushes clones out by `radius`/`spacing`/etc., so the real
 * geometry is routinely much bigger than that static box — for
 * `DEFAULT_CONFIG` the mark was cropped by more than half. Deriving the size
 * and viewBox from `contentBounds` instead means the box always contains
 * whatever `renderShapes` actually produced, no matter which knobs pushed it
 * out.
 */
export async function toSvg(cfg: GeoShapeConfig, opts: Partial<SvgDocOptions> = {}): Promise<string> {
  const shapes = await renderShapes(cfg)
  const b = contentBounds(shapes)
  await embedShapePaints(shapes)
  return frameSvg(shapes, b, framePad(cfg), opts)
}

/**
 * Convert each shape's authored `paint` (gradient/pattern) into a real
 * `VectorPaint` the SVG writer can turn into a `<linearGradient>`/`<pattern>`
 * — the solid-fallback `.fill` `composite` set is only a placeholder for this.
 * `null` (image/shader, TIER 3 — see toVector.ts's header) means
 * `paintToVectorPaint` has no vector form to offer without a raster; the block
 * below supplies one. Mutates `shapes[].fill` in place. Shared by `toSvg` and
 * `studioToSvg` so the single-mark and layered SVG paths embed paint identically.
 *
 * The paint is boxed to EACH SHAPE'S OWN bounds, not the whole-mark bounds: a
 * gradient/ombre/pattern anchors to the object it fills, so every clone/piece
 * shows the FULL ramp within itself.
 */
async function embedShapePaints(shapes: VectorShape[]): Promise<void> {
  for (const s of shapes as GeoVectorShape[]) {
    if (s.paint && typeof s.paint !== 'string') {
      const vp = await vectorPaintFor(s, s.paint)
      if (vp) s.fill = vp
    }
    // A gradient/pattern OUTLINE embeds the same way — the SVG writer takes a
    // paint server on `stroke` just as on `fill`.
    if (s.strokePaint && typeof s.strokePaint !== 'string') {
      const vp = await vectorPaintFor(s, s.strokePaint)
      if (vp) s.stroke = vp
    }
  }
}

/** One shape's authored `paint` → a `VectorPaint` boxed to that shape's bounds. */
async function vectorPaintFor(s: VectorShape, paint: Paint): Promise<VectorPaint | null> {
  const sb = contentBounds([s])
  const box = { x: sb.minX, y: sb.minY, width: sb.w, height: sb.h }
  let vp = paintToVectorPaint(paint, { units: 'userSpaceOnUse', box })
  // TIER 3 embed: rasterize the paint over `box` on an offscreen canvas —
  // same `resolvePaintCanvas` path `drawToCanvas`/`warmPaints` use, so the
  // embedded pixels match the live preview — and ask again with the raster
  // in hand, which the image/shader arms both turn into a
  // `<pattern>`-with-`<image>` (see `rasterTile` in toVector.ts). DOM-only:
  // under SSR or a headless unit test (no `document`) this stays skipped
  // and the shape keeps its solid fallback.
  if (vp === null && typeof document !== 'undefined') {
    const raster = await rasterizePaint(paint, box.width, box.height)
    if (raster) vp = paintToVectorPaint(paint, { units: 'userSpaceOnUse', box, raster })
  }
  return vp
}

/** The final framed box (document coords) a mark's `bounds` grown by `pad`
 *  occupies — the SAME extent+centre `frameSvg`/`drawToCanvas` frame into. */
function frameBox(bounds: { minX: number; minY: number; w: number; h: number }, pad: number): { x: number; y: number; w: number; h: number } {
  const w = paddedExtent(bounds.w, pad)
  const h = paddedExtent(bounds.h, pad)
  const cx = bounds.minX + bounds.w / 2
  const cy = bounds.minY + bounds.h / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** A full-frame rectangle shape carrying the background `paint`, drawn first
 *  (behind the marks). Non-solid paints ride on `.paint` so `embedShapePaints`
 *  boxes them to the rect's own (full-frame) bounds; the solid `.fill` is the
 *  synchronous fallback. */
function backgroundRectShape(box: { x: number; y: number; w: number; h: number }, paint: Paint): GeoVectorShape {
  const { x, y, w, h } = box
  const commands: VectorCommand[] = [
    { command: 'moveTo', args: [x, y] },
    { command: 'lineTo', args: [x + w, y] },
    { command: 'lineTo', args: [x + w, y + h] },
    { command: 'lineTo', args: [x, y + h] },
    { command: 'closePath', args: [] },
  ]
  return { commands, fill: typeof paint === 'string' ? paint : FALLBACK_FILL, paint }
}

/**
 * Wrap paint-embedded `shapes` into an SVG document framed by `bounds` grown by
 * `pad`. Uses `paddedExtent` + a mark-CENTRED viewBox (rather than `minX - pad`)
 * so the frame stays correct when negative padding overscans: the box can shrink
 * below the mark and crop it symmetrically without going non-positive. For
 * non-negative padding this is identical to the old `minX - pad` box. Shared by
 * the single-mark and layered SVG paths.
 */
function frameSvg(
  shapes: VectorShape[],
  bounds: { minX: number; minY: number; w: number; h: number },
  pad: number,
  opts: Partial<SvgDocOptions> = {},
): string {
  const w = paddedExtent(bounds.w, pad)
  const h = paddedExtent(bounds.h, pad)
  const cx = bounds.minX + bounds.w / 2
  const cy = bounds.minY + bounds.h / 2
  return shapesToSVG(shapes, {
    width: w,
    height: h,
    viewBox: [cx - w / 2, cy - h / 2, w, h],
    ...opts,
  })
}

/** Apply a layer's placement (offset/scale/rotate) to its already-composed,
 *  document-space shapes. The mark is origin-centred (see `renderShapes`), so
 *  scale/rotate turn about the mark's own centre; `flipY: false` keeps the
 *  already-final orientation (no second y-flip). Identity offsets pass through
 *  untouched (no per-point work, no new arrays). */
function applyLayerOffset(shapes: VectorShape[], off: GeoLayer['offset']): VectorShape[] {
  if (off.x === 0 && off.y === 0 && off.scale === 1 && off.rotate === 0) return shapes
  return shapes.map((s) => ({
    ...s,
    commands: transformCommands(s.commands, { x: off.x, y: off.y, scale: off.scale, rotate: off.rotate, flipY: false }),
  }))
}

/**
 * A layered `GeoStudioDoc` -> one flat `VectorShape[]` in document space, the
 * SAME shape list the preview, PNG bake, and SVG export all consume (so the
 * three stay pixel-identical). Enabled layers render bottom→top via the
 * existing single-mark `renderShapes`, each placed by its `offset`, then
 * concatenated — later layers paint over earlier ones. A one-layer doc with a
 * native offset is byte-identical to `renderShapes(layer.mark)`.
 *
 * When `doc.overlap.enabled`, the regions where ≥2 layers cross are computed
 * (`overlapFaces`) and appended AFTER the layers so they overpaint the
 * intersections with the stack overlap palette.
 *
 * NOTE: per-layer opacity/blend are NOT applied here — flat concatenation can't
 * isolate a layer's internal overlaps, so honouring them needs group compositing
 * (Phase 3).
 */
export async function renderStudio(doc: GeoStudioDoc): Promise<VectorShape[]> {
  // Per-layer shape groups are kept (not just flattened) so the overlap pass can
  // union each layer into a silhouette and intersect silhouettes across layers.
  const perLayer: VectorShape[][] = []
  for (const layer of doc.layers) {
    if (!layer.enabled) continue
    const shapes = await renderShapes(layer.mark)
    perLayer.push(applyLayerOffset(shapes, layer.offset))
  }
  const out: VectorShape[] = perLayer.flat()
  if (doc.overlap.enabled && perLayer.length >= 2) {
    out.push(...(await overlapFaces(perLayer, doc.overlap)))
  }
  return out
}

/** The frame margin (document units) for a whole layered composite — `framePad`
 *  driven by the stack `doc.padding`, with the largest enabled-layer DRAWN stroke
 *  half-width folded in so no outline clips at the edge. Each layer is measured
 *  by the same rule `framePad` uses for a single mark (an outline layer draws at
 *  `strokeWidth || 1`), because each layer carries its own `paintTarget`. */
export function studioFramePad(doc: GeoStudioDoc): number {
  let maxStroke = 0
  for (const l of doc.layers) if (l.enabled) maxStroke = Math.max(maxStroke, drawnStrokeWidth(l.mark.strokeWidth, l.mark.paintTarget))
  return framePad({ padding: doc.padding, strokeWidth: maxStroke })
}

/** A layered `GeoStudioDoc` -> a standalone SVG document, framed by the stack
 *  padding over the union bounds of all layers. Shares `embedShapePaints` +
 *  `frameSvg` with `toSvg`, so the layered SVG and the single-mark SVG frame and
 *  embed paint identically. */
export async function studioToSvg(doc: GeoStudioDoc, opts: Partial<SvgDocOptions> = {}): Promise<string> {
  const shapes = await renderStudio(doc)
  const b = contentBounds(shapes)
  const pad = studioFramePad(doc)
  const bg = doc.background
  const hasBg = !!bg && bg !== 'none'
  // A SOLID background rides `shapesToSVG`'s own `background` option — the one
  // case it already renders as a literal full-bleed `<rect>` behind every
  // `<path>` (see its doc), which is both simpler and cheaper than a shape.
  // A non-solid (gradient/pattern/image) background has no such native slot,
  // so it is prepended as its own full-frame `VectorShape` instead, letting
  // `embedShapePaints` turn its `.paint` into a real paint-server fill exactly
  // like any other shape's.
  const solidBg = hasBg && typeof bg === 'string' ? bg : undefined
  const withBg = hasBg && typeof bg !== 'string'
    ? [backgroundRectShape(frameBox(b, pad), bg as Paint), ...shapes]
    : shapes
  await embedShapePaints(withBg)   // embeds a gradient/image background too
  return frameSvg(withBg, b, pad, { background: solidBg, ...opts })
}

/** A fallback colour for a fill `resolvePaintCanvas` cannot resolve yet (image/
 *  shader before Task 4 warms them): mid-gray reads as "there is a fill here"
 *  without claiming to be the real one. Also `resolvePaintCanvas`'s own solid
 *  arm needs no fallback — a plain string passes straight through. */
const FALLBACK_FILL = '#808080'

/**
 * A still (`t: 0`, not baking) field frame — the minimal `ShaderFieldFrameCtx`
 * a shader-fill `Paint` needs to resolve on canvas. This host has no separate
 * "frame" the way the Compositor's paintLayerStack does, so a `frame`-anchored
 * shader (`field.frameW`/`frameH`) is out of scope here — object-anchored
 * shaders (the common case, `OBJECT_SHADER_FIELD_PX`) don't read those fields
 * at all. `token: 0` is `resolveField`'s own "no span open" sentinel (see
 * `~/lib/shaderfill/field.ts`), so a shader fill here reads the current/frozen
 * field rather than erroring — exactly the graceful image/shader fallback
 * this task's brief calls for.
 */
const STILL_FIELD: ShaderFieldFrameCtx = { frameW: 1, frameH: 1, t: 0, fps: 30, base: null, bake: false, token: 0 }

/**
 * Paint `shapes` onto a 2D canvas context, fit to the `w`×`h` box.
 *
 * The shapes are origin-centred document-space geometry, but their real
 * extent depends on `arrange`'s knobs (`radius`/`spacing`/etc.), not on the
 * canvas size — a fixed `translate(w/2,h/2)` with no scale crops the mark
 * exactly like `toSvg`'s old static-size bug. Fitting `contentBounds` grown
 * by `pad` (document units, from `framePad(cfg)`) into the box via `fitScale`
 * keeps the preview/bake replay honest AND matches `toSvg`'s framing exactly,
 * so the live preview, the PNG bake, and the SVG download all inset the mark
 * by the same margin. `pad === 0` fills the box edge-to-edge on its tight axis
 * (the "Padding" control at 0), which is how a mark is made to fill the canvas.
 *
 * Used by both the live preview and the bake path, so there is one canvas
 * replay of this geometry, matching `toSvg`'s one SVG replay.
 *
 * Fills go through the SAME `resolvePaint` the Compositor/Vector Type use
 * (aliased `resolvePaintCanvas` here — see this module's header on the two
 * `resolvePaint`s), so gradients/patterns/solid paint for real instead of the
 * old cheap first-stop/mid-gray stand-in. Image/shader paints resolve to
 * `FALLBACK_FILL` until their bitmap/field is warmed — this function stays
 * synchronous on purpose (it is also the bake/hit-test replay), so warming is
 * the CALLER's job: `warmPaints` below, then call this again. That degrades
 * gracefully either way; it never throws.
 */
export function drawToCanvas(
  shapes: VectorShape[], ctx: CanvasRenderingContext2D,
  w: number, h: number, pad = 0, background: Paint | null = null,
): void {
  ctx.clearRect(0, 0, w, h)
  // Document background: a full-output rect behind the padding frame and every
  // shape. Painted in the UNTRANSFORMED device frame (before the fit/centre
  // transform below) so it spans the whole canvas, not the mark's box. `null`
  // and the 'none'/'' sentinels stay transparent (the historical behaviour).
  if (background && background !== 'none') {
    if (typeof background === 'string') {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, w, h)
    } else {
      const style = resolvePaintCanvas(ctx, background as Paint, { w, h }, STILL_FIELD)
      ctx.fillStyle = (style as any) ?? FALLBACK_FILL
      ctx.fillRect(0, 0, w, h)
    }
  }
  const b = contentBounds(shapes)
  const scale = fitScale(b, w, h, pad)
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(scale, scale)
  ctx.translate(-(b.minX + b.w / 2), -(b.minY + b.h / 2))
  for (const s of shapes) {
    const path = new Path2D(commandsToPathData(s.commands))
    const rule: CanvasFillRule = s.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
    const paint = (s as GeoVectorShape).paint ?? s.fill
    if (paint) {
      if (typeof paint === 'string') {
        // Solid colour ignores geometry — fill the document-space path directly.
        ctx.fillStyle = paint
        ctx.fill(path, rule)
      } else {
        // Gradient/ombre/pattern/shader anchors to the OBJECT it fills:
        // `resolvePaintCanvas` centres the ramp on the drawing origin and spans
        // the passed `{ w, h }`, so translate the origin to THIS shape's centre
        // and pass its OWN bounds — otherwise every shape samples a slice of one
        // mark-wide ramp (the bug). The path is redrawn in that shape-local frame
        // (document path shifted by -centre) so it lands back at its real spot.
        const sb = contentBounds([s])
        const cx = sb.minX + sb.w / 2, cy = sb.minY + sb.h / 2
        ctx.save()
        ctx.translate(cx, cy)
        const style = resolvePaintCanvas(ctx, paint as Paint, { w: sb.w, h: sb.h }, STILL_FIELD)
        const local = new Path2D()
        local.addPath(path, new DOMMatrix().translateSelf(-cx, -cy))
        ctx.fillStyle = (style as any) ?? FALLBACK_FILL
        ctx.fill(local, rule)
        ctx.restore()
      }
    }
    const strokePaint = (s as GeoVectorShape).strokePaint ?? s.stroke
    if (strokePaint) {
      ctx.lineWidth = s.strokeWidth ?? 1
      if (typeof strokePaint === 'string') {
        ctx.strokeStyle = strokePaint
        ctx.stroke(path)
      } else {
        // Same object-anchored frame as the fill arm above: the ramp spans THIS
        // shape's own bounds, so every outlined clone shows its full gradient.
        const sb = contentBounds([s])
        const cx = sb.minX + sb.w / 2, cy = sb.minY + sb.h / 2
        ctx.save()
        ctx.translate(cx, cy)
        const style = resolvePaintCanvas(ctx, strokePaint as Paint, { w: sb.w, h: sb.h }, STILL_FIELD)
        const local = new Path2D()
        local.addPath(path, new DOMMatrix().translateSelf(-cx, -cy))
        ctx.strokeStyle = (style as any) ?? FALLBACK_FILL
        ctx.stroke(local)
        ctx.restore()
      }
    }
  }
  ctx.restore()
}

// ── Task 4: image/shader warm pass ──────────────────────────────────────────

/** Every shape's authored `Paint` — the same value `drawToCanvas` reads paint
 *  from (`.paint ?? .fill`) — for a caller (`ShapeStudioSurface`) that needs to
 *  know what to warm without re-deriving that fallback itself. */
export function shapePaints(shapes: VectorShape[]): Paint[] {
  const out: Paint[] = []
  for (const s of shapes) {
    const p = (s as GeoVectorShape).paint ?? s.fill
    if (p) out.push(p as Paint)
    // A non-solid OUTLINE paint warms like a fill; a solid stroke string has
    // nothing to warm, so an outline-only solid mark still reports nothing.
    const sp = (s as GeoVectorShape).strokePaint
    if (sp && typeof sp !== 'string') out.push(sp)
  }
  return out
}

/** The paints a studio doc needs warmed before a real paint/rasterize: every
 *  shape's authored paint (via `shapePaints`) plus the document background.
 *  Solid/null entries are harmless — `hasAsyncPaint` filters them; only
 *  image/shader entries actually cost a warm. */
export function studioWarmPaints(shapes: VectorShape[], background: Paint | null): Paint[] {
  const out = shapePaints(shapes)
  if (background && background !== 'none') out.push(background)
  return out
}

/** True when `paint` is an `ImageFill` or a shader `Fill` — the two `Paint`
 *  kinds `resolvePaintCanvas`/`resolveField` can only resolve for real AFTER an
 *  async warm (`getFillBitmap`/`resolveField`'s cache is empty on the first
 *  ask). Every other `Paint` kind (solid/gradient/procedural pattern) resolves
 *  synchronously already, so it is deliberately excluded here — warming it
 *  would just be wasted work with nothing to cache. */
function isAsyncPaint(paint: Paint | undefined): boolean {
  return isImageFill(paint) || (isFill(paint) && fillIsShader(paint))
}

/** Whether ANY of `paints` needs `warmPaints` — the guard `ShapeStudioSurface`
 *  checks before paying for a second `drawToCanvas` pass; skips it entirely
 *  for a solid/gradient/pattern-only mark, which already paints for real on
 *  the first (synchronous) pass. */
export function hasAsyncPaint(paints: (Paint | undefined)[]): boolean {
  return paints.some(isAsyncPaint)
}

/**
 * Warm the image-bitmap and shader-field caches `resolvePaintCanvas`
 * (`drawToCanvas` above) and `paintToVectorPaint`'s raster arm (`toSvg` below,
 * Task 4 Step 2) both read SYNCHRONOUSLY, so a caller that repaints/rasterizes
 * after this resolves gets the real paint instead of `FALLBACK_FILL`.
 *
 * Mirrors the Compositor's own warm-then-paint split, not a new scheme:
 *  - **images** — `ensureFillBitmaps`, the same call
 *    `useCompositorLayers.ts:610`'s `ensureLayerImages` makes.
 *  - **shaders** — `withFieldFrame` + `resolveField`, the same pairing
 *    `useCompositorLayers.ts:1680`'s `paintLayerStack` makes once per painted
 *    frame (see `resolveShaderFill`'s "Shader fills on frame primitives" doc
 *    in `~/lib/paint/resolve.ts` for why a HOST must own one synchronous span
 *    rather than share `liveKeys` with another host's).
 *
 * ONE deliberate difference from the Compositor: this host has no per-frame
 * render loop of its own (`ShapeStudioSurface`'s preview is event/dirty-driven
 * — see its own doc), so unlike `paintLayerStack`'s span (which self-heals for
 * free on the NEXT frame if the shader-effect catalog is still loading), a
 * cold catalog here would leave the field frozen on its input-fill fallback
 * forever with nothing to retry it. So this ALSO awaits
 * `fetchShaderFxCatalog()` first — the same one-shot-host pattern
 * `VectorTypeSurface.vue`'s `renderFullResBlob`/`exportSvg` use for their own
 * PNG/SVG exports.
 *
 * `box` matches `resolvePaintCanvas`'s own `{ w, h }` convention and sizes a
 * FRAME-anchored shader request exactly like `useCompositorLayers.ts`'s
 * `addShaderFieldRequest` does. It plays no part in the common case though:
 * an OBJECT-anchored field (`resolveShaderFill`'s `OBJECT_SHADER_FIELD_PX`
 * arm) always renders at that fixed size regardless of `box`, and
 * `getFillBitmap` keys an image purely on `src`. A frame-anchored shader is
 * out of scope for THIS host regardless (see `STILL_FIELD`'s doc — paint time
 * always asks for a 1×1 field), so warming one at `box`'s size builds a cache
 * entry paint time never actually reads; harmless, just not load-bearing.
 */
export async function warmPaints(paints: (Paint | undefined)[], box: { w: number; h: number }): Promise<void> {
  const imgSrcs = new Set<string>()
  const shaderSpecs: ShaderSpec[] = []
  for (const p of paints) {
    if (isImageFill(p) && p.src) imgSrcs.add(p.src)
    else if (isFill(p) && fillIsShader(p)) shaderSpecs.push(p.shader)
  }
  const jobs: Promise<unknown>[] = []
  if (imgSrcs.size) jobs.push(ensureFillBitmaps([...imgSrcs]))
  if (shaderSpecs.length) {
    jobs.push(
      fetchShaderFxCatalog()
        .catch(() => { /* offline/backend down — resolveShaderFill degrades to the input fill, same as before */ })
        .then(() => {
          const requests: FieldRequest[] = shaderSpecs.map(spec => ({
            spec,
            w: spec.anchor === 'frame' ? Math.max(1, Math.round(box.w)) : OBJECT_SHADER_FIELD_PX,
            h: spec.anchor === 'frame' ? Math.max(1, Math.round(box.h)) : OBJECT_SHADER_FIELD_PX,
            t: STILL_FIELD.t, fps: STILL_FIELD.fps, bake: STILL_FIELD.bake,
          }))
          // One synchronous span for every shader this warm pass carries — see this
          // function's own doc on why that has to be true here just like it is in
          // paintLayerStack. Discards the returned canvases: this call's only job is
          // to populate resolveField's cache so the NEXT (synchronous) resolve, made
          // through STILL_FIELD outside any span (token 0 — see its doc), hits it.
          withFieldFrame(requests, (_frozenCount, token) => {
            for (const req of requests) resolveField(req, token)
          })
        }),
    )
  }
  if (jobs.length) await Promise.all(jobs)
}

/**
 * Rasterize `paint` over a `w`×`h` rect to a `data:image/png` URL — the pixel
 * source `toSvg`'s TIER 3 embed hands `paintToVectorPaint` as `raster`
 * (`~/lib/paint/toVector.ts`). Warms first (`warmPaints`) so an image/shader
 * paint isn't captured mid-`FALLBACK_FILL`, then paints through the SAME
 * `resolvePaintCanvas` path `drawToCanvas` uses, centred the same way, so the
 * embedded pixels match the live preview rather than being a second, drifting
 * rasterizer. The tile is corner-origin ([0,0]..[w,h], unclipped — same
 * convention `rasterTile`'s SVG placement assumes: the `<pattern>` IS the box,
 * and the referencing shape's own `fill-rule` clips it, not this pixel data).
 *
 * DOM-only (creates a `<canvas>`) — `toSvg` only calls this after checking
 * `document` exists, so this itself does not re-guard.
 */
async function rasterizePaint(paint: Paint, w: number, h: number): Promise<string | null> {
  await warmPaints([paint], { w, h })
  const cw = Math.max(1, Math.round(w))
  const ch = Math.max(1, Math.round(h))
  const off = document.createElement('canvas')
  off.width = cw
  off.height = ch
  const ctx = off.getContext('2d')
  if (!ctx) return null
  ctx.translate(cw / 2, ch / 2)
  const style = resolvePaintCanvas(ctx, paint, { w: cw, h: ch }, STILL_FIELD)
  ctx.fillStyle = (style as any) ?? FALLBACK_FILL
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch)
  return off.toDataURL('image/png')
}
