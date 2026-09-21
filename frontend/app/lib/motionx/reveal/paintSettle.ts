// The canvas half of the Settle family (Addendum 3). Like Pixels and Assemble it TRANSFORMS the
// layer — drawn ALONE onto a frame-sized side canvas, run through a Shader Studio effect,
// stamped back with the layer's own opacity and blend — but nothing here is a mask: the layer
// arrives whole and BROKEN, and the effect's strength runs down to nothing as the bar plays
// (`settle.ts`'s pure maths).
//
// The one real problem this file solves is TRANSPARENCY. Nine of the ten effects write fully
// OPAQUE pixels, and clipping the result back to the layer's outline would be wrong on its own
// terms — a slice could then never leave the letter it came from, which is the whole point of
// the look. So the transparency is RECOVERED exactly, in three GPU passes:
//   1. the effect over the layer PREMULTIPLIED ONTO BLACK  → colour × coverage;
//   2. the SAME effect, same clock, same uniforms, over the layer's COVERAGE (white on black);
//   3. a combine pass that divides one by the other — colour = (1) ÷ (2), alpha = (2).
// Per channel, so a colour split's red fringe keeps its own coverage. Exact for every effect
// that moves or averages pixels, which is all ten of them.
//
// Step 1 (the frame-transform gate and the solo pass), the scratch-canvas pools and the
// injectable GPU calls are `paintPixels.ts`'s — shared, so the three styles can never disagree
// about what "the frame's own pixels" are, and so one `setRevealPixelsDeps` covers all of them.
import { expandPasses } from '~/lib/shaderfx/renderer'
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import {
  acquireScratch, fieldCombine, fieldReady, fieldRender, releaseScratch, releaseSolo, soloPass,
} from './paintPixels'
import { settleEffectOf, settleFade, settleParams, settleSpec, settleStrength, settleUniforms } from './settle'
import type { SettleEffect } from './settle'
import type { MotionReveal } from './params'

type Canvas = HTMLCanvasElement

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** The combine pass's program-cache key. Not a catalogue effect: there is no Shader Studio entry
 *  for "divide colour by coverage", and there should not be — it is plumbing, not a look. */
export const SETTLE_COMBINE_ID = 'sailor_settle_combine'

/**
 * Step 3: undo the premultiply. `u_image0` is the effect's picture of the layer over black
 * (colour × coverage); `u_cover` is the SAME effect's picture of the layer's coverage.
 *
 * Header and conventions are the catalogue's own (`u_image0`, `v_texCoord`, `fragColor0`) so the
 * shared renderer's blit, uniform writes and `BUILTIN_PASS_DEFAULTS` all apply unchanged. The
 * context is WebGL2 with `premultipliedAlpha: false`: what comes out here is STRAIGHT alpha,
 * which is what the renderer's canvas readback and the `drawImage` below both expect.
 */
export const SETTLE_COMBINE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_cover;
uniform vec2 u_resolution;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() {
  vec3 a = texture(u_image0, v_texCoord).rgb;          // colour × coverage
  vec3 kc = texture(u_cover, v_texCoord).rgb;          // coverage, per channel
  float alpha = max(kc.r, max(kc.g, kc.b));
  vec3 rgb = alpha > 0.0 ? a / max(kc, vec3(1e-4)) : vec3(0.0);
  // a channel with no coverage of its own (a colour split's fringe) keeps its own value
  rgb = mix(a, rgb, step(vec3(1e-4), kc));
  fragColor0 = vec4(clamp(rgb, 0.0, 1.0), alpha);
}`

/** The defaults of the ONE reader of a settle bar's stored params — borrowed rather than
 *  re-declared, so this file can never drift from `settleParams`. */
const NOTE_DEFAULTS = settleParams(undefined)

/** The transient note the fold parked on the layer clone, defaulted exactly as `settleParams`
 *  defaults the stored params it was built from: an unknown tile id falls back to Slice, a
 *  missing or non-finite strength to 70%, a missing switch to "fade". */
function settleNote(reveal: MotionReveal): { effect: SettleEffect; strength: number; fade: boolean } {
  const n = reveal.settle
  return {
    effect: settleEffectOf(n?.effect),
    strength: typeof n?.strength === 'number' && Number.isFinite(n.strength)
      ? Math.min(1, Math.max(0, n.strength))
      : NOTE_DEFAULTS.strength,
    fade: n?.fade !== false,
  }
}

/** The one place `ctx` is touched: stamp `picture` at the frame's own top-left with the layer's
 *  own blend and the (already faded) alpha. Balanced on a throw by the caller's `finally`. */
function stampPicture(
  ctx: CanvasRenderingContext2D, picture: Canvas, base: DOMMatrix, alpha: number, blend: GlobalCompositeOperation,
): void {
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = blend
  ctx.drawImage(picture, base.e, base.f)
}

/**
 * Draw one layer's Settle transition frame.
 *
 * `base` is the FRAME's own transform, captured by the caller before any draw-time scale is
 * applied — the shader runs at the frame's own pixel size, not at a per-layer scale.
 *
 * Fail-safe, exactly like `drawRevealPixels` / `drawRevealAssemble`: every early return happens
 * before `ctx` is touched, so a caller that gets `false` back can fall through as if this was
 * never called. Pools are stacks; a `try/finally` releases every scratch canvas on every path,
 * including a throw from a canvas-to-canvas draw.
 *
 * `true` is the ordinary answer even while the catalogue is cold — see the plain-fade branch.
 */
export function drawRevealSettle(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
): boolean {
  // 1. The frame-transform gate and the solo pass (shared with Pixels and Assemble).
  const pass = soloPass(ctx, W, H, base, drawLayer)
  if (!pass) return false
  const { solo, fw, fh } = pass

  const note = settleNote(reveal)
  // The stamp's alpha for THIS frame: the layer's own opacity, ramped over the bar's first
  // quarter when "Fade while it settles" is on.
  const alpha = clamp01(stamp.alpha * settleFade(reveal.amount, note.fade))

  // While the effect is still loading a settle bar is a PLAIN FADE, not the Dissolve mask: a
  // settle bar has no mask look, and dissolving would be a different transition rather than a
  // degraded one. Asking also kicks the load, so the next frame heals itself.
  if (!fieldReady(note.effect.effectId)) {
    let saved = false
    try {
      ctx.save()
      saved = true
      stampPicture(ctx, solo, base, alpha, stamp.blend)
      ctx.restore()
      saved = false
    } finally {
      if (saved) ctx.restore()
      releaseSolo(solo)
    }
    return true
  }

  // Everything from here on only draws between canvases. `held` is the release list: a canvas
  // joins it the moment it leaves its pool, so even a throw mid-compose puts all of them back.
  const held: [string, Canvas][] = []
  const take = (name: string, w: number, h: number) => {
    const canvas = acquireScratch(name)
    held.push([name, canvas])
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const c2d = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!c2d) return null
    // Pooled: whatever the last frame left on this context must not tint this one.
    c2d.setTransform(1, 0, 0, 1, 0, 0)
    c2d.globalAlpha = 1
    return { canvas, g: c2d }
  }
  let saved = false
  try {
    // 2a. The colour input: the layer PREMULTIPLIED ONTO BLACK — opaque, so an effect that
    // ignores alpha (most of the ten) still has real colour to move around, and every pixel it
    // writes is already colour × coverage.
    const colourIn = take('settleColour', fw, fh)
    if (!colourIn) return false
    colourIn.g.globalCompositeOperation = 'copy'
    colourIn.g.fillStyle = '#000000'
    colourIn.g.fillRect(0, 0, fw, fh)
    colourIn.g.globalCompositeOperation = 'source-over'
    colourIn.g.drawImage(solo, 0, 0)

    // 2b. The coverage input: WHITE where the layer is, on BLACK. `source-in` paints white only
    // where the layer's own alpha already is (keeping partial coverage as grey), `destination-over`
    // then fills the rest with black.
    const coverIn = take('settleCover', fw, fh)
    if (!coverIn) return false
    coverIn.g.globalCompositeOperation = 'copy'
    coverIn.g.drawImage(solo, 0, 0)
    coverIn.g.globalCompositeOperation = 'source-in'
    coverIn.g.fillStyle = '#ffffff'
    coverIn.g.fillRect(0, 0, fw, fh)
    coverIn.g.globalCompositeOperation = 'destination-over'
    coverIn.g.fillStyle = '#000000'
    coverIn.g.fillRect(0, 0, fw, fh)

    // 3. The two shader passes. ONE spec, ONE uniform set, ONE clock for both — anything else and
    // the two pictures do not line up, and the division in step 4 produces fringes rather than
    // removing them. `settleUniforms` rides as an OVERRIDE (merged after the effect's own params,
    // never clamped by the manifest) so a dial whose rest value sits below the Studio slider's
    // minimum still reaches exactly `rest` and the bar ends on the identity.
    const elapsedSeconds = Number.isFinite(reveal.elapsed) ? Math.max(0, reveal.elapsed) : 0
    const spec = settleSpec(note.effect) as unknown as ShaderSpec
    const uniforms = settleUniforms(note.effect, settleStrength(reveal.amount, note.strength))

    // `fieldRender` THROWS on a cold catalog — `fieldReady` said otherwise above, but a race (the
    // catalog evicting between that check and this call) must still fail safe. The canvas it
    // returns belongs to the shared renderer and is only valid until the NEXT render call, so
    // each result is copied into a pooled canvas AT ONCE.
    const copyOf = (name: string, result: Canvas) => {
      const held = take(name, fw, fh)
      if (!held) return null
      held.g.globalCompositeOperation = 'copy'
      held.g.drawImage(result, 0, 0)
      return held
    }

    let colourOut: { canvas: Canvas } | null
    try {
      colourOut = copyOf('settleColourOut', fieldRender(spec, colourIn.canvas, fw, fh, undefined, elapsedSeconds, uniforms))
    } catch { return false }
    if (!colourOut) return false

    let coverOut: { canvas: Canvas } | null
    try {
      coverOut = copyOf('settleCoverOut', fieldRender(spec, coverIn.canvas, fw, fh, undefined, elapsedSeconds, uniforms))
    } catch { return false }
    if (!coverOut) return false

    // 4. Divide one by the other on the GPU. `u_cover` changes every frame, so it goes through
    // `render`'s LIVE textures (re-uploaded per call) rather than a pass's `textures`, whose
    // contract is a stable, identity-cached object.
    let combined: Canvas
    try {
      combined = fieldCombine(
        expandPasses(SETTLE_COMBINE_ID, SETTLE_COMBINE_FRAG, {}, undefined, 1),
        colourOut.canvas, fw, fh, { u_cover: coverOut.canvas },
      )
    } catch { return false }
    const out = copyOf('settleOut', combined)
    if (!out) return false

    // 5. Stamp with the layer's own blend and the faded opacity, at the frame's own position.
    ctx.save()
    saved = true
    stampPicture(ctx, out.canvas, base, alpha, stamp.blend)
    ctx.restore()
    saved = false
    return true
  } finally {
    if (saved) ctx.restore()
    releaseSolo(solo)
    for (const [name, canvas] of held) releaseScratch(name, canvas)
  }
}
