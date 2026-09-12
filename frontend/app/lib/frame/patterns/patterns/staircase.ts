import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const staircase: Pattern = {
  id: 'staircase',
  name: 'Staircase',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 11)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.55, measure), mb.h / (1.25 * words.length))
    const blockH = sizePx * 1.1 * words.length
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'staircase', jitterX: r.range(0, 0.1), jitterY: 0, seed: ctx.seed | 0 },
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dc = toNorm({ x: mb.x, y: mb.y, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: 'title stepped down the page, one word per line' }
  },
}
