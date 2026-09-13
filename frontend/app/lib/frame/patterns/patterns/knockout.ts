import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const knockout: Pattern = {
  id: 'knockout',
  name: 'Knockout',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 13)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    const words = elements.title?.words ?? ['WORD']
    if (sh) {
      // a big solid shape filling most of the frame, aspect-locked
      const wpx = Math.min(mb.w, mb.h / sh.aspect) * r.range(0.82, 1)
      const hpx = wpx * sh.aspect
      const xLeft = mb.x + (mb.w - wpx) / 2
      const yTop = mb.y + (mb.h - hpx) / 2
      const sc = toNorm({ x: xLeft, y: yTop, w: wpx, h: hpx }, frame)
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: sc.x, y: sc.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'ink', fill: 'solid', z: 0 })
      // the title reversed out of it, centred, in the field colour
      const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
      const size = Math.min(fitSize(widest, wpx * 0.7, measure), hpx / (1.25 * words.length))
      const blockH = size * 0.86 * words.length
      const tc = toNorm({ x: xLeft, y: yTop + (hpx - blockH) / 2, w: wpx, h: blockH }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: (wpx * 0.7) / frame.w, fontSize: size / frame.w, align: 'center', lineBreak: words.join('\n'), colorRole: 'field', z: 1 })
    } else {
      // no shape resolved (shouldn't happen given needs.shape, but keep a title op)
      const size = fitSize(words.join(' '), mb.w, measure)
      const tc = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: size }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'center', colorRole: 'ink' })
    }
    return { ops, did: `title knocked out of a solid ${sh ? sh.id : 'shape'}` }
  },
}
