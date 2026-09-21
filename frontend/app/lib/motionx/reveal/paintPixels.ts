// The canvas half of the Pixels reveal style. Unlike `paint.ts`'s three MASK styles — which
// show or hide the layer's own already-rendered pixels — Pixels TRANSFORMS the layer: it is
// drawn ALONE onto a frame-sized side canvas, run through the Shader Studio `ascii_dither`
// effect in "matte" mode, optionally cross-faded to the sharp layer near the end of the bar,
// and stamped back with the layer's own opacity and blend.
//
// This is the one file in this folder that touches `~/lib/shaderfill/field` (a WebGL entry
// point) — deliberately NOT re-exported from `./index` (the reveal barrel stays DOM/WebGL
// free): only `useCompositorLayers.ts` and this file's own spec may import it directly.
import { fieldEffectReady, renderFieldWithBase } from '~/lib/shaderfill/field'
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import { pixelShaderParams, pixelSharp } from './pixels'
import type { MotionReveal } from './params'

type Canvas = HTMLCanvasElement

let makeCanvas: () => Canvas = () => document.createElement('canvas')
let render: typeof renderFieldWithBase = renderFieldWithBase
let ready: () => boolean = () => fieldEffectReady('ascii_dither')

/** Tests only: swap the canvas factory, the shader render call, and/or the readiness check
 *  so the spec never touches WebGL or the shaderfx catalog. Swapping the canvas factory
 *  resets both scratch pools, so a fake canvas from a previous test can never leak into the
 *  next one. */
export function setRevealPixelsDeps(deps: {
  makeCanvas?: () => Canvas
  render?: typeof renderFieldWithBase
  ready?: () => boolean
}): void {
  if (deps.makeCanvas) { makeCanvas = deps.makeCanvas; soloPool.length = 0; outPool.length = 0 }
  if (deps.render) render = deps.render
  if (deps.ready) ready = deps.ready
}

// Two STACKS, not singletons — mirrors paint.ts's `pool`/`smallPool` split. `solo` holds the
// layer's own pixels, `out` holds the shader's (copied) result; both are fw×fh, kept in
// separate pools so a throw while building `solo` can never release a canvas `out` still
// needs, or vice versa.
const soloPool: Canvas[] = []
const outPool: Canvas[] = []
const acquire = (from: Canvas[]) => from.pop() ?? makeCanvas()

/** True once the ASCII effect can render everything Pixels needs (see `fieldEffectReady`).
 *  False both while the catalog is still loading and (self-healingly) kicks that load. */
export function revealPixelsReady(): boolean {
  return ready()
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * Draw one layer's Pixels transition frame.
 *
 * `base` is the FRAME's own transform, captured by the caller before any draw-time scale is
 * applied — the ASCII grid belongs to the frame, not to a per-layer scale. `ctx`'s CURRENT
 * transform (read here via `ctx.getTransform()`) may already carry that draw-time scale on
 * top of `base`; `drawLayer` still needs to see the full current transform so the layer
 * draws at the size/position it would anyway.
 *
 * Fail-safe: every early return happens before `ctx` is touched — a caller that gets `false`
 * back can fall through to the Dissolve mask exactly as if this was never called.
 */
export function drawRevealPixels(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
): boolean {
  // 1. The frame transform must be scale + translate only — a rotated/skewed frame has no
  // axis-aligned pixel size to render the shader at.
  if (Math.abs(base.b) > 1e-6 || Math.abs(base.c) > 1e-6) return false
  const fw = Math.round(W * base.a)
  const fh = Math.round(H * base.d)
  if (fw < 2 || fh < 2 || fw * fh > 16_000_000) return false

  // 2. Draw the layer alone onto a frame-sized side canvas. Its transform is the CURRENT one
  // (base, plus whatever draw-time scale the caller already applied on top of it) moved so
  // the frame's own top-left lands on the canvas origin.
  const solo = acquire(soloPool)
  if (solo.width !== fw) solo.width = fw
  if (solo.height !== fh) solo.height = fh
  const sctx = solo.getContext('2d')
  if (!sctx) { soloPool.push(solo); return false }
  let drawn = false
  try {
    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.clearRect(0, 0, fw, fh)
    sctx.setTransform(new DOMMatrix().translate(-base.e, -base.f).multiply(ctx.getTransform()))
    drawLayer(sctx)
    drawn = true
  } finally {
    // A throw still releases the canvas, then propagates — the caller sees the exception,
    // not a swallowed `false`.
    if (!drawn) soloPool.push(solo)
  }

  // 3. Run it through the ASCII shader in matte mode. `renderFieldWithBase` THROWS on a cold
  // catalog — the caller already checked `revealPixelsReady()` before calling this, but a
  // race (the catalog evicting between that check and this call) must still fail safe.
  const elapsedSeconds = Number.isFinite(reveal.elapsed) ? Math.max(0, reveal.elapsed) : 0
  const spec = {
    effectId: 'ascii_dither',
    params: pixelShaderParams(reveal, W, H),
    speed: 1,
    seed: 42,
  } as unknown as ShaderSpec
  let result: Canvas
  try {
    result = render(spec, solo, fw, fh, undefined, elapsedSeconds, { u_matte: 1 })
  } catch {
    soloPool.push(solo)
    return false
  }

  // The rendered canvas is only valid until the next render call — copy it at once. Reset
  // alpha/composite explicitly (not just the transform): `out` is pooled and its previous
  // life may have left the cross-fade alpha from step 4 set on it.
  const out = acquire(outPool)
  if (out.width !== fw) out.width = fw
  if (out.height !== fh) out.height = fh
  const octx = out.getContext('2d')
  if (!octx) { soloPool.push(solo); outPool.push(out); return false }
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalAlpha = 1
  octx.globalCompositeOperation = 'copy'
  octx.drawImage(result, 0, 0)

  // 4. Sharp hand-off: the last fifth of the bar cross-fades to the real, sharp layer.
  const s = pixelSharp(reveal.amount)
  if (s > 0) {
    octx.globalCompositeOperation = 'source-over'
    octx.globalAlpha = s
    octx.drawImage(solo, 0, 0)
  }

  // 5. Stamp with the layer's own opacity and blend, at the frame's own position.
  ctx.save()
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = clamp01(stamp.alpha)
  ctx.globalCompositeOperation = stamp.blend
  ctx.drawImage(out, base.e, base.f)
  ctx.restore()

  // 6. Release both scratch canvases.
  soloPool.push(solo)
  outPool.push(out)
  return true
}
