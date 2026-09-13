import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const split: Pattern = {
  id: 'split',
  name: 'Split',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 16)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const img = elements.images[0]
    const photoLeft = r.chance(0.5)
    const cut = frame.w * r.range(0.42, 0.55)   // vertical cut x
    if (img) {
      const pxLeft = photoLeft ? 0 : cut
      const pw = photoLeft ? cut : frame.w - cut
      const c = toNorm({ x: pxLeft, y: 0, w: pw, h: frame.h }, frame)
      ops.push({ target: img.id, kind: 'image', x: c.x, y: c.y, w: pw / frame.w, h: frame.h / frame.w, fill: 'photo', z: 0 })
    }
    // title stacked in the OTHER half, a fixed gap clear of the cut AND inside the
    // margin on the outer side — so it never overlaps the photo at any margin.
    const words = elements.title?.words ?? ['WORD']
    const gap = frame.w * 0.03
    const colX = photoLeft ? cut + gap : mb.x
    const colRight = photoLeft ? frame.w - mb.x : cut - gap
    const colW = colRight - colX
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const size = Math.min(fitSize(widest, colW, measure), mb.h / (1.2 * words.length))
    const blockH = size * 0.86 * words.length
    const tc = toNorm({ x: colX, y: (frame.h - blockH) / 2, w: colW, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: colW / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    return { ops, did: `photo on the ${photoLeft ? 'left' : 'right'} half, title on the other` }
  },
}
