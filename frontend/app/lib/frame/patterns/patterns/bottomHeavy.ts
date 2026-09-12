import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const bottomHeavy: Pattern = {
  id: 'bottomHeavy',
  name: 'Bottom-heavy',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 6)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const lowerH = mb.h * r.range(0.5, 0.62)                 // the title owns the lower band
    const widthFit = fitSize(widest, mb.w, measure)
    const heightFit = lowerH / (0.9 * words.length)
    const sizePx = Math.min(widthFit, heightFit)
    const blockH = sizePx * 0.86 * words.length
    const yTop = mb.y + mb.h - blockH                        // anchored to the foot margin
    const align = r.pick(['left', 'center'] as const)
    const c = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align, lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // small texts up top, with air between them and the title
    const smallSize = frame.w * 0.022
    if (elements.details) {
      const dc = toNorm({ x: mb.x, y: mb.y, w: mb.w * 0.6, h: smallSize }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.6) / frame.w, fontSize: smallSize / frame.w, align: 'left', colorRole: 'ink' })
    }
    if (elements.date) {
      const dc = toNorm({ x: mb.x + mb.w - mb.w * 0.35, y: mb.y, w: mb.w * 0.35, h: smallSize }, frame)
      ops.push({ target: 'date', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.35) / frame.w, fontSize: smallSize / frame.w, align: 'right', colorRole: 'accent' })
    }
    if (elements.caption) {
      const cc = toNorm({ x: mb.x, y: mb.y + smallSize * 1.6, w: mb.w * 0.6, h: smallSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.6) / frame.w, fontSize: smallSize / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title anchored to the foot, ${align}; the rest up top` }
  },
}
