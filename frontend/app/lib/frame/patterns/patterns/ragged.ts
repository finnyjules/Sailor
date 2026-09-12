import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const ragged: Pattern = {
  id: 'ragged',
  name: 'Ragged',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 9)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const wpl = r.pick([1, 2] as const)
    const lines = Math.ceil(words.length / wpl)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.7, measure), mb.h / (1.3 * lines))
    const blockH = sizePx * 1.05 * lines
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: wpl, placement: 'random', jitterX: r.range(0.4, 0.85), jitterY: r.range(0, 0.15), seed: ctx.seed | 0 },
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dc = toNorm({ x: mb.x, y: mb.y + mb.h - s, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: 'title words placed ragged across the page' }
  },
}
