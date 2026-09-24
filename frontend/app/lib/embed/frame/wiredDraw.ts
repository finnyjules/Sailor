/**
 * How big a wired layer's SOURCE is drawn — the one sizing rule shared by the planner (the
 * pre-rendered route's `maxPx`) and the Frame player (a nested live player's device size).
 *
 * Bundle-safe and pure: the Frame bundle imports it, so no Vue and no app registry.
 *
 * It mirrors the painter (useCompositorLayers.ts, `wiredBoxPx` + the wired branch of the layer
 * draw), not the layer's own box:
 * - the box is `w·W` wide; it is `h·W` tall when the layer has a `crop` and an `h`, otherwise it
 *   follows the aspect it draws at — the SOURCE's own aspect, or `lastAspect` when `unlinked`;
 * - the source is cover-cropped (`crop.fit === 'cover'`) or stretched into that box. Either way,
 *   drawing it without upscaling on either axis needs the source at
 *   `max(boxW / srcW, boxH / srcH)` of its own size.
 * A 16:9 source in a portrait 300×533 box is therefore drawn 948 px wide, not 300.
 */

/** The fields of a wired layer this rule reads. */
export interface WiredDrawLayer {
  w?: number
  h?: number
  crop?: unknown
  lastAspect?: number
  unlinked?: boolean
}

/**
 * The long side, in Frame (artboard) pixels, a wired layer's source is drawn at, keeping the
 * source's aspect. `srcW`/`srcH` is the source's size (any unit — only the aspect counts); when it
 * is missing or not a real size, `lastAspect` stands in for it (the host keeps `lastAspect` equal
 * to the content's aspect for every layer that is not `unlinked`). 0 for a layer that draws
 * nothing (`w <= 0`). Unclamped: callers clamp to what they can render.
 */
export function wiredSourceLongSide(layer: WiredDrawLayer, frameW: number, srcW?: number, srcH?: number): number {
  const w = Number(layer.w) || 0
  const W = Number(frameW) || 0
  if (!(w > 0) || !(W > 0)) return 0
  const last = Number(layer.lastAspect) > 0 ? Number(layer.lastAspect) : 1
  const srcAspect = Number(srcW) > 0 && Number(srcH) > 0 && Number.isFinite(Number(srcH) / Number(srcW))
    ? Number(srcH) / Number(srcW)
    : last
  const h = Number(layer.h) || 0
  const boxW = w * W
  const boxH = layer.crop && h > 0 ? h * W : boxW * (layer.unlinked ? last : srcAspect)
  // The source as 1 × srcAspect: the scale that covers the box on both axes, then its long side.
  const scale = Math.max(boxW, boxH / srcAspect)
  return Math.max(1, srcAspect) * scale
}
