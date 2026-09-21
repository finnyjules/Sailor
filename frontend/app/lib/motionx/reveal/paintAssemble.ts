// The canvas half of the Assemble reveal style. Like Pixels it TRANSFORMS the layer — drawn
// ALONE onto a frame-sized side canvas, run through a Shader Studio effect, stamped back with
// the layer's own opacity and blend — but the blocks never refine: they stay ONE size, and two
// scattered fronts wipe them in (`assemble.ts`'s pure maths) and then turn them sharp.
//
// The whole trick is that both masks are built on the SHADER'S OWN cell grid, which the shader
// anchors at the canvas's BOTTOM-left (the WebGL texcoord origin) — so every rect here is
// `(0, fh − rows·cellH, cols·cellW, rows·cellH)`, not `(0, 0, fw, fh)`, and a mask edge can
// never cut a cell in half.
//
// Steps 1–2 (the frame-transform gate and the solo pass), the scratch-canvas pools and the
// injectable shader call are `paintPixels.ts`'s — shared, so the two styles can never disagree
// about what "the frame's own pixels" are, and so one `setRevealPixelsDeps` covers both.
import type { ShaderSpec } from '~/lib/spacetype/fillTile'
import { acquireScratch, fieldRender, releaseScratch, releaseSolo, soloPass } from './paintPixels'
import { assembleGrid, assembleShaderExtras, assembleShaderParams, buildAssembleMasks } from './assemble'
import type { MotionReveal } from './params'

type Canvas = HTMLCanvasElement

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * Draw one layer's Assemble transition frame.
 *
 * `base` is the FRAME's own transform, captured by the caller before any draw-time scale is
 * applied — the block grid belongs to the frame, not to a per-layer scale.
 *
 * Fail-safe, exactly like `drawRevealPixels`: every early return happens before `ctx` is
 * touched, so a caller that gets `false` back can fall through to the Dissolve mask as if this
 * was never called. Pools are stacks; a `try/finally` releases every scratch canvas on every
 * path, including a throw from a canvas-to-canvas draw.
 */
export function drawRevealAssemble(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
): boolean {
  // 1–2. The frame-transform gate and the solo pass (shared with Pixels).
  const pass = soloPass(ctx, W, H, base, drawLayer)
  if (!pass) return false
  const { solo, fw, fh } = pass

  // 2b. The look shader's dials, and the cell grid it will lay over the side canvas.
  const shader = assembleShaderParams(reveal, W, H)
  const { cols, rows, cellW, cellH } = assembleGrid(reveal, W, H, fw, fh)
  // The shader's grid, in the side canvas's own pixels: anchored at the BOTTOM-left, so it
  // overhangs the TOP when `fh` is not a whole number of cells (`gy` is then negative, and
  // `drawImage` clips that overhang to transparent for us — which is exactly right: there is
  // nothing above the canvas to sample).
  const gw = cols * cellW
  const gh = rows * cellH
  const gy = fh - gh

  // 3. The look picture. `fieldRender` THROWS on a cold catalog — the caller already checked
  // `revealShaderReady(reveal)`, but a race (the catalog evicting between that check and this
  // call) must still fail safe.
  const elapsedSeconds = Number.isFinite(reveal.elapsed) ? Math.max(0, reveal.elapsed) : 0
  const spec = {
    effectId: shader.effectId,
    params: shader.params,
    speed: 1,
    seed: 42,
  } as unknown as ShaderSpec
  // Dither look → the SHIMMER build, whose threshold pattern slides under the blocks by the
  // same whole-cell drift that moves the scatter order; Characters → the ASCII MATTE build.
  const extras = assembleShaderExtras(reveal)
  let result: Canvas
  try {
    result = fieldRender(spec, solo, fw, fh, undefined, elapsedSeconds, extras.uniforms, extras.variant)
  } catch {
    releaseSolo(solo)
    return false
  }

  // Everything from here on only draws between canvases. `held` is the release list: a canvas
  // joins it the moment it leaves its pool, so even a throw mid-compose puts all of them back.
  const held: [string, Canvas][] = []
  const take = (name: string, w: number, h: number, settings?: CanvasRenderingContext2DSettings) => {
    const canvas = acquireScratch(name)
    held.push([name, canvas])
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const c2d = canvas.getContext('2d', settings) as CanvasRenderingContext2D | null
    return c2d ? { canvas, g: c2d } : null
  }
  let saved = false
  try {
    // The rendered canvas is only valid until the next render call — copy it AT ONCE.
    const look = take('look', fw, fh)
    if (!look) return false
    look.g.setTransform(1, 0, 0, 1, 0, 0)
    look.g.globalAlpha = 1
    look.g.globalCompositeOperation = 'copy'
    look.g.drawImage(result, 0, 0)

    // 4. Coverage, the Dither look only: `bayer_dither` writes OPAQUE colour over the whole
    // canvas, so without this every cell the layer does not actually cover would assemble as a
    // solid block of the backdrop's colour. Squeeze the layer's own alpha down to one pixel per
    // cell (smoothing ON — we want the cell's average, not its top-left corner).
    let covered: Uint8Array | undefined
    if (shader.effectId === 'bayer_dither') {
      const cover = take('cover', cols, rows, { willReadFrequently: true })
      if (!cover) return false
      cover.g.setTransform(1, 0, 0, 1, 0, 0)
      cover.g.globalAlpha = 1
      cover.g.imageSmoothingEnabled = true
      cover.g.globalCompositeOperation = 'copy'
      cover.g.drawImage(solo, 0, gy, gw, gh, 0, 0, cols, rows)
      const alpha = cover.g.getImageData(0, 0, cols, rows).data
      covered = new Uint8Array(cols * rows)
      for (let k = 0; k < covered.length; k++) covered[k] = (alpha[k * 4 + 3] ?? 0) > 127 ? 1 : 0
    }

    // 5. The two masks — one cell per pixel, cut into their pictures at the anchored rect with
    // smoothing OFF so each mask pixel stays a hard-edged block.
    const masks = buildAssembleMasks(reveal, { cols, rows }, covered)
    const cut = (name: string, bits: Uint8ClampedArray<ArrayBuffer>, into: CanvasRenderingContext2D): boolean => {
      const mask = take(name, cols, rows)
      if (!mask) return false
      // putImageData ignores transform, alpha and composite by definition — it replaces.
      mask.g.putImageData(new ImageData(bits, cols, rows), 0, 0)
      into.setTransform(1, 0, 0, 1, 0, 0)
      into.globalAlpha = 1
      into.imageSmoothingEnabled = false
      into.globalCompositeOperation = 'destination-in'
      into.drawImage(mask.canvas, 0, gy, gw, gh)
      return true
    }
    if (!cut('maskLook', masks.look, look.g)) return false

    // The sharp side of the transition is the layer's own pixels — masked on a COPY, because
    // `solo` is still the source the Dither look's coverage (and any later frame) reads.
    const sharp = take('sharp', fw, fh)
    if (!sharp) return false
    sharp.g.setTransform(1, 0, 0, 1, 0, 0)
    sharp.g.globalAlpha = 1
    sharp.g.globalCompositeOperation = 'copy'
    sharp.g.drawImage(solo, 0, 0)
    if (!cut('maskSharp', masks.sharp, sharp.g)) return false

    // 6. Compose the two, and stamp with the layer's own opacity and blend at the frame's
    // own position.
    const out = take('out', fw, fh)
    if (!out) return false
    out.g.setTransform(1, 0, 0, 1, 0, 0)
    out.g.globalAlpha = 1
    out.g.imageSmoothingEnabled = false
    out.g.globalCompositeOperation = 'copy'
    out.g.drawImage(look.canvas, 0, 0)
    out.g.globalCompositeOperation = 'source-over'
    out.g.drawImage(sharp.canvas, 0, 0)

    ctx.save()
    saved = true
    ctx.filter = 'none'
    ctx.shadowColor = 'transparent'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = clamp01(stamp.alpha)
    ctx.globalCompositeOperation = stamp.blend
    ctx.drawImage(out.canvas, base.e, base.f)
    ctx.restore()
    saved = false
    return true
  } finally {
    if (saved) ctx.restore()
    releaseSolo(solo)
    for (const [name, canvas] of held) releaseScratch(name, canvas)
  }
}
