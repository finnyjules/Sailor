import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters step down the frame, one per line, on a staircase
 *  indent — a diagonal cascade. Single word only (a phrase runs too tall). */
export const cascade: Pattern = {
  id: 'cascade',
  name: 'Cascade',
  fits: ['word'],
  place(ctx) {
    const r = rngFor(ctx.seed, 21)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    // One glyph per band; size so L bands fill the height, capped so a glyph
    // never exceeds a comfortable width (the staircase indents within the box).
    const size = Math.min((mb.h / L) * 0.9, fitSize('M', mb.w * 0.5, measure))
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'staircase', jitterX: r.range(0, 0.2), jitterY: 0, seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters cascading down the frame' }
  },
}
