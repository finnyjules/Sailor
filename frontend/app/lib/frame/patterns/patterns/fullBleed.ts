import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const fullBleed: Pattern = {
  id: 'fullBleed',
  name: 'Full bleed',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 17)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const c = toNorm({ x: 0, y: 0, w: frame.w, h: frame.h }, frame)
    ops.push({ target: elements.images[0]?.id ?? 'image', kind: 'image', x: c.x, y: c.y, w: 1, h: frame.h / frame.w, fill: 'photo', z: 0 })
    // title big, reversed, anchored top or bottom
    const words = elements.title?.words ?? ['WORD']
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), mb.h / (1.3 * words.length))
    const blockH = size * 0.86 * words.length
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const align = r.pick(['left', 'center'] as const)
    const tc = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align, lineBreak: words.join('\n'), colorRole: 'field', z: 1 })
    return { ops, did: `photo full-bleed, title reversed over it, ${top ? 'top' : 'bottom'}` }
  },
}
