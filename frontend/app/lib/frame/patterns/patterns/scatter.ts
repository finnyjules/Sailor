import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters scattered across the frame — big, sparse, expressive.
 *  Best on a single word; the engine drops the spaces of a short phrase. */
export const scatter: Pattern = {
  id: 'scatter',
  name: 'Scatter',
  fits: ['word', 'phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 20)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    const perLine = Math.max(1, Math.min(8, Math.round(Math.sqrt(L))))
    const rows = Math.ceil(L / perLine)
    // Size each glyph to about half its cell so `random` placement has room to
    // scatter it; cap by the row height so `rows` bands fit the box.
    const size = Math.min(fitSize('M', (mb.w / perLine) * 0.55, measure), (mb.h / rows) * 0.8)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: perLine, placement: 'random', jitterX: r.range(0.6, 0.9), jitterY: r.range(0.5, 0.9), seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters scattered across the frame' }
  },
}
