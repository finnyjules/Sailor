import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters set around a circle, centred in the frame. Single word. */
export const ring: Pattern = {
  id: 'ring',
  name: 'Ring',
  fits: ['word'],
  place(ctx) {
    const r = rngFor(ctx.seed, 22)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const side = Math.min(mb.w, mb.h)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    // Size a glyph to a fraction of the circumference so the ring reads as letters.
    const size = Math.min(fitSize('M', (Math.PI * side) / Math.max(6, L) * 0.9, measure), side * 0.22)
    const c = toNorm({ x: mb.x + (mb.w - side) / 2, y: mb.y + (mb.h - side) / 2, w: side, h: side }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: side / frame.w, boxH: side / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'ring', jitterX: r.range(0, 0.25), jitterY: r.range(0, 0.2), seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters set around a ring' }
  },
}
