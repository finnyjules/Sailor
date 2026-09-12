import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const edges: Pattern = {
  id: 'edges',
  name: 'Edges',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 10)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const wpl = 2
    const lines = Math.ceil(words.length / wpl)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.5, measure), mb.h / (1.3 * lines))
    const blockH = sizePx * 1.1 * lines
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: wpl, placement: 'edges', jitterX: r.range(0, 0.2), jitterY: 0, seed: ctx.seed | 0 },
    }]
    return { ops, did: 'title words pushed to the left and right edges' }
  },
}
