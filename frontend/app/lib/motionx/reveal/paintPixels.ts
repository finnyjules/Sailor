// The canvas half of the Pixels reveal style. Unlike `paint.ts`'s three MASK styles — which
// show or hide the layer's own already-rendered pixels — Pixels TRANSFORMS the layer: it is
// drawn ALONE onto a frame-sized side canvas, run through the Shader Studio `ascii_dither`
// effect in "matte" mode, optionally cross-faded to the sharp layer near the end of the bar,
// and stamped back with the layer's own opacity and blend.
//
// This is the one file in this folder that touches `~/lib/shaderfill/field` (a WebGL entry
// point) — deliberately NOT re-exported from `./index` (the reveal barrel stays DOM/WebGL
// free): only `useCompositorLayers.ts`, the export/bake entries (`~/lib/motion/bake.ts`,
// `CompositorModal.vue`), `./paintAssemble.ts` and this file's own spec may import it directly.
//
// It is also the SHADER-STYLE front door for all THREE of them: `drawRevealShaderStyle` routes a
// bar to Pixels, to Assemble or to Settle, `revealShaderReady` / `ensureRevealShadersReady`
// answer for the effect THAT bar needs, and `soloPass` (steps 1–2) plus the scratch pools below
// are shared, so the styles can never disagree about what "the frame's own pixels" are.
import { fieldEffectReady, whenFieldEffectReady, renderFieldWithBase } from '~/lib/shaderfill/field'
import { shaderFx } from '~/lib/shaderfx/renderer'
import type { ShaderPass } from '~/lib/shaderfx/renderer'
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import { pixelShaderParams, pixelSharp } from './pixels'
import { assembleShaderParams } from './assemble'
import { revealEffectIdsFor } from './params'
import type { MotionReveal } from './params'
import { drawRevealAssemble } from './paintAssemble'
import { drawRevealSettle } from './paintSettle'
import { buildCustomAtlas } from '~/lib/shaderfx/customGlyphs'

type Canvas = HTMLCanvasElement

let makeCanvas: () => Canvas = () => document.createElement('canvas')
let render: typeof renderFieldWithBase = renderFieldWithBase
let ready: () => boolean = () => fieldEffectReady('ascii_dither')
let whenReady: (timeoutMs?: number) => Promise<boolean> = (timeoutMs) => whenFieldEffectReady('ascii_dither', timeoutMs)
// The same two questions asked of a NAMED effect — Assemble's Dither look needs `bayer_dither`,
// its Characters look (and every Pixels bar) `ascii_dither`. The two above stay because they
// are the Pixels-only contract `revealPixelsReady` / `ensureRevealPixelsReady` still honour.
let readyFx: (effectId: string) => boolean = (id) => fieldEffectReady(id)
let whenReadyFx: (effectId: string, timeoutMs?: number) => Promise<boolean> = (id, ms) => whenFieldEffectReady(id, ms)
// Settle's THIRD pass: the shared renderer driven directly, with a frag of our own rather than a
// catalogue effect (there is no catalogue entry for "divide colour by coverage"). Injectable for
// the same reason `render` is — a spec must never reach WebGL.
let combine: (
  passes: ShaderPass[], base: TexImageSource, width: number, height: number, live?: Record<string, TexImageSource>,
) => Canvas = (passes, base, width, height, live) => shaderFx.render(passes, base, width, height, live)
let warn: (message: string) => void = (message) => { if (import.meta.dev) console.warn(message) }
// The Custom ASCII shape's runtime glyph sheet (Task 15) — injectable so a spec never touches a
// real `<canvas>` (the real `buildCustomAtlas` rasterizes text). Shared by both painters.
let customAtlas: (chars: string) => TexImageSource = buildCustomAtlas

/** Tests only: swap the canvas factory, the shader render call, the readiness checks and/or
 *  the dev warning sink so the spec never touches WebGL or the shaderfx catalog. Swapping
 *  the canvas factory resets EVERY scratch pool (Assemble's as well as Pixels' two), so a
 *  fake canvas from a previous test can never leak into the next one; swapping the warning
 *  sink resets its once-per-session latch, for the same reason. */
export function setRevealPixelsDeps(deps: {
  makeCanvas?: () => Canvas
  render?: typeof renderFieldWithBase
  ready?: () => boolean
  whenReady?: (timeoutMs?: number) => Promise<boolean>
  readyFx?: (effectId: string) => boolean
  whenReadyFx?: (effectId: string, timeoutMs?: number) => Promise<boolean>
  combine?: typeof combine
  warn?: (message: string) => void
  customAtlas?: (chars: string) => TexImageSource
}): void {
  if (deps.makeCanvas) {
    makeCanvas = deps.makeCanvas
    soloPool.length = 0; outPool.length = 0
    for (const pool of extraPools.values()) pool.length = 0
  }
  if (deps.render) render = deps.render
  if (deps.ready) ready = deps.ready
  if (deps.whenReady) whenReady = deps.whenReady
  if (deps.readyFx) readyFx = deps.readyFx
  if (deps.whenReadyFx) whenReadyFx = deps.whenReadyFx
  if (deps.combine) combine = deps.combine
  if (deps.warn) { warn = deps.warn; warnedOversize = false }
  if (deps.customAtlas) customAtlas = deps.customAtlas
}

/** The Custom ASCII shape's runtime glyph atlas, as the `textures` argument
 *  `renderFieldWithBase` wants — built only when `reveal.chars` selects Custom (14); every
 *  baked set needs no extra texture at all. Shared by both painters (Pixels always; Assemble
 *  only for its Characters look, the one look that runs the ASCII effect) so the two can never
 *  disagree about when the atlas is asked for. */
export function customGlyphTextures(reveal: { chars: number; customChars?: string }): Record<string, TexImageSource> | undefined {
  return reveal.chars === 14 ? { u_customGlyphs: customAtlas(reveal.customChars ?? '') } : undefined
}

/** The widest/tallest side the shader pass is rendered at. The old gate was on AREA
 *  (16,000,000 px), which is below an ordinary 4096×4096 artboard and below 16:9 at
 *  5334×3000 — so a perfectly normal export silently came out in the Dissolve look
 *  instead. A canvas SIDE is what browsers and GL actually limit, so that is what this
 *  gates on. */
const MAX_FRAME_SIDE = 8192
let warnedOversize = false
/** Says ONCE per session, in dev, that the character transition has been swapped for the
 *  Dissolve mask — the one fallback here the user cannot otherwise tell apart from a
 *  deliberate choice of style. */
function warnOversize(fw: number, fh: number): void {
  if (warnedOversize) return
  warnedOversize = true
  warn(
    `[motionx] the dither transition's shader needs a frame of at most ${MAX_FRAME_SIDE}px on a side; ` +
    `this frame is ${fw}×${fh}px, which is too large, so the Dissolve mask is used instead.`,
  )
}

// Two STACKS, not singletons — mirrors paint.ts's `pool`/`smallPool` split. `solo` holds the
// layer's own pixels, `out` holds the shader's (copied) result; both are fw×fh, kept in
// separate pools so a throw while building `solo` can never release a canvas `out` still
// needs, or vice versa.
const soloPool: Canvas[] = []
const outPool: Canvas[] = []
/** Assemble's own scratch stacks, by role (look picture, coverage, the two masks, the sharp
 *  copy, the composite). They live HERE rather than in `paintAssemble.ts` so that one
 *  `setRevealPixelsDeps({ makeCanvas })` still resets every pool in the folder. */
const extraPools = new Map<string, Canvas[]>()
const acquire = (from: Canvas[]) => from.pop() ?? makeCanvas()
const poolOf = (name: string): Canvas[] => {
  let pool = extraPools.get(name)
  if (!pool) { pool = []; extraPools.set(name, pool) }
  return pool
}
/** `paintAssemble.ts` only. Pools are STACKS, like Pixels' two. */
export function acquireScratch(name: string): Canvas {
  return acquire(poolOf(name))
}
export function releaseScratch(name: string, canvas: Canvas): void {
  poolOf(name).push(canvas)
}
/** `paintAssemble.ts` only: hand the shared solo canvas back after `soloPass` handed it out. */
export function releaseSolo(canvas: Canvas): void {
  soloPool.push(canvas)
}
/** `paintAssemble.ts` / `paintSettle.ts` only: the injectable shader call, so one
 *  `setRevealPixelsDeps({ render })` covers every style. Throws exactly as `renderFieldWithBase`
 *  does on a cold catalog. */
export function fieldRender(...args: Parameters<typeof renderFieldWithBase>): Canvas {
  return render(...args) as Canvas
}

/** `paintSettle.ts` only: the injectable direct drive of the shared renderer, for the combine
 *  pass — a frag of ours, not a catalogue effect. The canvas it returns is the renderer's own
 *  and is valid only until the NEXT render call, exactly like `fieldRender`'s. */
export function fieldCombine(
  passes: ShaderPass[], base: TexImageSource, width: number, height: number, live?: Record<string, TexImageSource>,
): Canvas {
  return combine(passes, base, width, height, live)
}

/** `paintSettle.ts` only: the injectable per-effect readiness check — asking also KICKS the
 *  catalogue load, which is how a settle bar's plain-fade frames heal themselves. */
export function fieldReady(effectId: string): boolean {
  return readyFx(effectId)
}

/** True once the ASCII effect can render everything Pixels needs (see `fieldEffectReady`).
 *  False both while the catalog is still loading and (self-healingly) kicks that load. */
export function revealPixelsReady(): boolean {
  return ready()
}

/**
 * The same question as an AWAIT, for a host that paints once and keeps the result: an
 * export. `true` once the shader can draw everything it needs, `false` if it still cannot
 * after `timeoutMs` (the field module's own default) — never throws, so a timed-out export
 * goes ahead in the Dissolve look rather than failing, exactly as a cold live frame does.
 *
 * Calling it also KICKS the load, so it doubles as the pre-warm.
 */
export function ensureRevealPixelsReady(timeoutMs?: number): Promise<boolean> {
  return whenReady(timeoutMs)
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * Steps 1–2 of BOTH shader styles' recipes: gate on the frame transform, then draw the layer
 * alone onto a frame-sized side canvas. Shared so Pixels and Assemble can never disagree about
 * what "the frame's own pixels" are.
 *
 * `null` means the style cannot run at this frame size and NOTHING was touched — not `ctx`, not
 * the pools — so the caller can fall through to the Dissolve mask as if it had never asked.
 * The returned `solo` canvas belongs to the caller until it calls `releaseSolo`; a throw from
 * `drawLayer` releases it here and propagates.
 */
export function soloPass(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
): { solo: Canvas; fw: number; fh: number } | null {
  // 1. The frame transform must be scale + translate only — a rotated/skewed frame has no
  // axis-aligned pixel size to render the shader at.
  if (Math.abs(base.b) > 1e-6 || Math.abs(base.c) > 1e-6) return null
  const fw = Math.round(W * base.a)
  const fh = Math.round(H * base.d)
  if (fw < 2 || fh < 2) return null
  if (fw > MAX_FRAME_SIDE || fh > MAX_FRAME_SIDE) { warnOversize(fw, fh); return null }

  // 2. Draw the layer alone onto a frame-sized side canvas. Its transform is the CURRENT one
  // (base, plus whatever draw-time scale the caller already applied on top of it) moved so
  // the frame's own top-left lands on the canvas origin.
  const solo = acquire(soloPool)
  if (solo.width !== fw) solo.width = fw
  if (solo.height !== fh) solo.height = fh
  const sctx = solo.getContext('2d')
  if (!sctx) { soloPool.push(solo); return null }
  let drawn = false
  try {
    // Pooled: whatever the last layer drawn here left on the context must not tint this one.
    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.globalAlpha = 1
    sctx.globalCompositeOperation = 'source-over'
    sctx.filter = 'none'
    sctx.clearRect(0, 0, fw, fh)
    sctx.setTransform(new DOMMatrix().translate(-base.e, -base.f).multiply(ctx.getTransform()))
    drawLayer(sctx)
    drawn = true
  } finally {
    // A throw still releases the canvas, then propagates — the caller sees the exception,
    // not a swallowed `null`.
    if (!drawn) soloPool.push(solo)
  }
  return { solo, fw, fh }
}

/** Which Shader Studio effect does a DITHER bar of this style and look need? `null` for the
 *  three MASK styles, which need none — and for `settle`, whose effect is the bar's own choice
 *  and whose readiness `revealShaderReady` answers before it ever asks here. */
function revealShaderEffect(reveal: MotionReveal): 'ascii_dither' | 'bayer_dither' | null {
  if (reveal.style === 'pixels') return 'ascii_dither'
  // The frame size only scales the effect's dials, never picks the effect — 1×1 is enough.
  if (reveal.style === 'assemble') return assembleShaderParams({ ...reveal, amount: 0, elapsed: 0 }, 1, 1).effectId
  return null
}

/** True once the effect THIS bar needs can render (see `fieldEffectReady`) — the Dither look's
 *  `bayer_dither`, or `ascii_dither` for Characters and for every Pixels bar. False both while
 *  the catalog is still loading and (self-healingly) kicks that load.
 *
 *  A SETTLE bar is the exception: always `true`. Its style has no mask look to fall back to —
 *  the Dissolve mask would be a different transition, not a degraded one — so `drawRevealSettle`
 *  owns the cold-catalogue frames itself and stamps the layer as a plain fade (kicking the load
 *  as it goes). The compositor must therefore take the side-canvas route for it from the first
 *  frame. */
export function revealShaderReady(reveal: MotionReveal): boolean {
  if (reveal.style === 'settle') return true
  const effectId = revealShaderEffect(reveal)
  return effectId ? readyFx(effectId) : false
}

/**
 * The same question as an AWAIT, for a host that paints once and keeps the result: an export.
 * Awaits every effect this frame's reveal bars actually need — a motion with one Assemble bar
 * in the Dither look, one Pixels bar and a Swirl settle bar waits for all THREE — and answers
 * `true` only if all of them arrived. Never throws, so a timed-out export goes ahead in the
 * fallback look (the Dissolve mask for a dither bar, a plain fade for a settle bar) rather than
 * failing, exactly as a cold live frame does.
 *
 * Which effects those are is `revealEffectIdsFor`'s answer, not this file's — so a bake, the
 * modal's pre-warm and this wait can never disagree about what a frame needs, and neither of
 * those two callers had to learn about settle bars.
 *
 * Calling it also KICKS those loads, so it doubles as the pre-warm.
 */
export async function ensureRevealShadersReady(
  behaviours: { kind: string; params?: Record<string, unknown> }[] | undefined,
  timeoutMs?: number,
): Promise<boolean> {
  const effects = revealEffectIdsFor(behaviours)
  if (effects.length === 0) return true
  const verdicts = await Promise.all(effects.map((id) => whenReadyFx(id, timeoutMs)))
  return verdicts.every(Boolean)
}

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
/** A TRUE cross-fade of `top` into whatever `g` holds: `g × (1 − s) + top × s`. Drawing `top`
 *  over it with `source-over` at alpha `s` is NOT that — where both pictures are partly
 *  transparent (every anti-aliased edge) the coverages stack, a(2 − a) instead of a, so edges
 *  come out heavier than the real layer's and the end of the bar pops. Found live: 3–6k edge
 *  pixels off by up to 79/255 at the hand-off. Scale what is there down, then ADD the rest. */
export function crossFade(g: CanvasRenderingContext2D, top: CanvasImageSource, s: number, w: number, h: number): void {
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'destination-out'
  g.globalAlpha = s
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'lighter'
  g.drawImage(top, 0, 0)
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'
}

export function drawRevealPixels(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
): boolean {
  // 1–2. The frame-transform gate and the solo pass, shared with Assemble.
  const pass = soloPass(ctx, W, H, base, drawLayer)
  if (!pass) return false
  const { solo, fw, fh } = pass

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
    // 'MATTE' compiles the ASCII shader's matte path in (`#define SAILOR_MATTE 1`, its own
    // cached program) — `u_matte: 1` then switches it on inside that program. Both: the
    // define is what keeps the CLASSIC program's token stream identical to the pre-matte
    // shader's, the uniform is the belt-and-braces runtime gate the renderer resets.
    result = render(spec, solo, fw, fh, undefined, elapsedSeconds, { u_matte: 1 }, 'MATTE', customGlyphTextures(reveal))
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
  // Everything from here on only draws between canvases; if one of those draws ever throws,
  // both scratch canvases still go back to their pools and `ctx` is left balanced.
  let saved = false
  try {
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalAlpha = 1
  octx.globalCompositeOperation = 'copy'
  octx.drawImage(result, 0, 0)

  // 4. Sharp hand-off: the last fifth of the bar cross-fades to the real, sharp layer.
  const s = pixelSharp(reveal.amount)
  if (s > 0) crossFade(octx, solo, s, fw, fh)

  // 5. Stamp with the layer's own opacity and blend, at the frame's own position.
  ctx.save()
  saved = true
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = clamp01(stamp.alpha)
  ctx.globalCompositeOperation = stamp.blend
  ctx.drawImage(out, base.e, base.f)
  ctx.restore()
  saved = false
  return true
  } finally {
    // 6. Release both scratch canvases — on every path.
    if (saved) ctx.restore()
    soloPool.push(solo)
    outPool.push(out)
  }
}

/**
 * The ONE entry point the compositor calls for a shader-style bar: Assemble draws constant
 * blocks wiped in by two scattered fronts, Pixels the refining character ladder, Settle the
 * layer broken by one of ten effects whose strength runs out. Same contract as any of them:
 * `false` leaves `ctx` untouched, so the caller falls through to the Dissolve mask.
 */
export function drawRevealShaderStyle(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
): boolean {
  if (reveal.style === 'settle') return drawRevealSettle(ctx, reveal, W, H, base, drawLayer, stamp)
  return reveal.style === 'assemble'
    ? drawRevealAssemble(ctx, reveal, W, H, base, drawLayer, stamp)
    : drawRevealPixels(ctx, reveal, W, H, base, drawLayer, stamp)
}
