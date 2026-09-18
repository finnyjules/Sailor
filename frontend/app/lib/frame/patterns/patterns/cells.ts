import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters packed into a grid — per-glyph, both axes justified. */
export const cells: Pattern = {
  id: 'cells',
  name: 'Cells',
  fits: ['word', 'phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 23)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    const perLine = Math.max(2, Math.min(8, Math.round(Math.sqrt(L * (mb.w / mb.h)))))
    const rows = Math.ceil(L / perLine)
    const size = Math.min(fitSize('M', (mb.w / perLine) * 0.8, measure), (mb.h / rows) * 0.9)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      align: 'justify', valign: 'justify', colorRole: 'ink',
      expressive: { wordsPerLine: perLine, placement: 'edges', jitterX: 0, jitterY: 0, seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters packed into a grid' }
  },
}
