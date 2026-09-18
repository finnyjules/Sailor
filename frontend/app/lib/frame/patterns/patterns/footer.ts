import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A big title up top, the small texts in a row along the bottom edge. */
export const footer: Pattern = {
  id: 'footer',
  name: 'Footer',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 26)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const footRowH = mb.h * 0.08
    const upperH = mb.h * 0.7                                  // title band; a clear gap to the foot row
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const size = Math.min(fitSize(widest, mb.w, measure), upperH / (1.15 * words.length))
    const tc = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: upperH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: tc.x, y: tc.y,
      w: mb.w / frame.w, boxH: upperH / frame.w, fontSize: size / frame.w,
      align: 'left', colorRole: 'ink',
    }]
    const feet = [elements.details, elements.date, elements.caption].filter(Boolean) as { role: string }[]
    const footY = mb.y + mb.h - footRowH / 2
    const cellW = mb.w / Math.max(1, feet.length)
    feet.forEach((el, i) => {
      const fc = toNorm({ x: mb.x + i * cellW, y: mb.y + mb.h - footRowH, w: cellW, h: footRowH }, frame)
      ops.push({ target: el.role as any, kind: 'text', x: fc.x, y: fc.y, w: cellW / frame.w, fontSize: footRowH * 0.6 / frame.w, align: 'left', colorRole: 'ink' })
    })
    void footY; void r
    return { ops, did: 'title up top, credits in a row along the foot' }
  },
}
