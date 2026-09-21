// The canvas half of a reveal: "draw the layer normally, then put the old picture back
// wherever the mask says hidden". Doing it this way round — instead of cutting the layer out
// on a side canvas — keeps blend modes, shadows and every effect that reads what is BEHIND the
// layer (background blur, glass, backdrop shaders) exactly as they are without a reveal.
import { buildHiddenMask, cellRange, dotRadius, DOT_PITCH_CELLS } from './dither'
import type { MotionReveal } from './params'

type Canvas = HTMLCanvasElement
let makeCanvas: () => Canvas = () => document.createElement('canvas')
/** Tests swap the canvas source; nothing else should. */
export function setRevealCanvasFactory(fn: () => Canvas): void { makeCanvas = fn; pool.length = 0; smallPool.length = 0 }

// STACKS, not singletons: a layer's own draw can re-enter paintLayerStack (glass / backdrop
// effects repaint what is below), and a lower layer may be mid-reveal too.
const pool: Canvas[] = []
const smallPool: Canvas[] = []
const acquire = (from: Canvas[]) => from.pop() ?? makeCanvas()

export interface RevealPass { snap: Canvas; base: DOMMatrix; reveal: MotionReveal; W: number; H: number }

export function beginReveal(ctx: CanvasRenderingContext2D, reveal: MotionReveal, W: number, H: number): RevealPass | null {
  const snap = acquire(pool)
  const dev = ctx.canvas
  if (snap.width !== dev.width) snap.width = dev.width
  if (snap.height !== dev.height) snap.height = dev.height
  const sctx = snap.getContext('2d')
  if (!sctx) { pool.push(snap); return null }
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalCompositeOperation = 'copy'
  sctx.drawImage(dev, 0, 0)
  return { snap, base: ctx.getTransform(), reveal, W, H }
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

type Painter = () => void
/** Build the hidden side once. `painterFor(c)` readies it for one context and hands back the
 *  draw (under the caller's transform and composite mode) — or NULL when that context cannot
 *  draw it, which `finishReveal` must learn BEFORE it touches a pixel: the recipe is only
 *  correct when the erase and BOTH halves of the put-back run with the same mask. `release`
 *  hands the scratch canvas back. */
function hiddenSide(pass: RevealPass, canvasW: number, canvasH: number): { painterFor: (c: CanvasRenderingContext2D) => Painter | null; release: () => void } {
  const { reveal, W, H, base } = pass
  const cellPx = reveal.cell * W
  const inv = base.inverse()
  const range = cellRange(inv, canvasW, canvasH, W, H, reveal.cell)
  const x = range.c0 * cellPx, y = range.r0 * cellPx, w = range.cols * cellPx, h = range.rows * cellPx
  const small = acquire(smallPool)
  if (reveal.style === 'dots') {
    const T = 64
    if (small.width !== T) small.width = T
    if (small.height !== T) small.height = T
    const t = small.getContext('2d')!
    t.setTransform(1, 0, 0, 1, 0, 0)
    t.globalCompositeOperation = 'copy'
    t.fillStyle = '#000'
    t.fillRect(0, 0, T, T)
    t.globalCompositeOperation = 'destination-out'
    t.beginPath(); t.arc(T / 2, T / 2, dotRadius(reveal.amount) * T, 0, Math.PI * 2); t.fill()
    const pitchPx = cellPx * DOT_PITCH_CELLS
    const slide = (Number.isFinite(reveal.elapsed) ? Math.max(0, reveal.elapsed) : 0) * reveal.drift * cellPx
    // The dot sits at the tile's CENTRE, so the tile origin is half a pitch before a dot centre.
    const ox = slide * Math.cos(reveal.angle), oy = slide * Math.sin(reveal.angle)
    return {
      painterFor(c) {
        const pattern = c.createPattern(small, 'repeat')
        if (!pattern) return null
        pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(pitchPx / T))
        return () => {
          c.imageSmoothingEnabled = true
          c.fillStyle = pattern
          c.fillRect(x, y, w, h)
        }
      },
      release: () => { smallPool.push(small) },
    }
  }
  if (small.width !== range.cols) small.width = range.cols
  if (small.height !== range.rows) small.height = range.rows
  const grid = cellRange(IDENTITY, W, H, W, H, reveal.cell)
  const m = small.getContext('2d')!
  m.putImageData(new ImageData(buildHiddenMask(reveal, range, grid), range.cols, range.rows), 0, 0)
  return {
    painterFor: (c) => () => { c.imageSmoothingEnabled = false; c.drawImage(small, x, y, w, h) },
    release: () => { smallPool.push(small) },
  }
}

export function finishReveal(ctx: CanvasRenderingContext2D, pass: RevealPass): void {
  const { snap, base } = pass
  const sctx = snap.getContext('2d')
  if (!sctx) { pool.push(snap); return }
  const hidden = hiddenSide(pass, ctx.canvas.width, ctx.canvas.height)
  const onSnap = hidden.painterFor(sctx), onCtx = hidden.painterFor(ctx)
  // Fail SAFE: if either side cannot draw the mask, leave the layer as it was drawn (no
  // dither this frame). Running half the recipe would add the whole backdrop over the layer.
  if (!onSnap || !onCtx) { hidden.release(); pool.push(snap); return }
  // the old picture, only where hidden
  sctx.setTransform(base)
  sctx.globalCompositeOperation = 'destination-in'
  onSnap()
  ctx.save()
  ctx.filter = 'none'; ctx.shadowColor = 'transparent'; ctx.globalAlpha = 1
  ctx.setTransform(base)
  ctx.globalCompositeOperation = 'destination-out'
  onCtx()                                             // erase layer + backdrop there…
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'lighter'
  ctx.drawImage(snap, 0, 0)                           // …and add the backdrop back
  ctx.restore()
  hidden.release()
  pool.push(snap)
}
