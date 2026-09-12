import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const spacedLines: Pattern = {
  id: 'spacedLines',
  name: 'Spaced lines',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 8)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    // size so the widest single word fits the width; bands then spread over boxH
    const sizePx = Math.min(fitSize(widest, mb.w, measure), mb.h / (1.2 * words.length))
    const align = r.pick(['left', 'center', 'right'] as const)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: sizePx / frame.w,
      align, valign: 'justify', colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'edges', jitterX: 0, jitterY: 0, seed: ctx.seed | 0 },
    }]
    if (elements.caption) {
      const s = frame.w * 0.02
      const cc = toNorm({ x: mb.x, y: mb.y + mb.h - s, w: mb.w, h: s }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: mb.w / frame.w, fontSize: s / frame.w, align, colorRole: 'ink' })
    }
    return { ops, did: `title on spaced lines filling the height, ${align}` }
  },
}
