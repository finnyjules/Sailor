import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const shapeCounter: Pattern = {
  id: 'shapeCounter',
  name: 'Shape counter-form',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 3)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    if (sh) {
      const wpx = frame.w * r.range(0.55, 1.05)
      const hpx = wpx * sh.aspect
      const xLeft = mb.x + (mb.w - wpx) * r.f()
      const yTop = mb.y + (mb.h - hpx) * r.f()
      const c = toNorm({ x: xLeft, y: yTop, w: wpx, h: hpx }, frame)
      ops.push({ target: 'shape', kind: 'shape', shapeId: sh.id, x: c.x, y: c.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
    }
    const text = elements.title?.text ?? 'WORD'
    const size = fitSize(text, mb.w * r.range(0.95, 1.25), measure)
    const wpx = measure(text) * (size / 100)
    const yTop = mb.y + (mb.h - size * 0.72) * r.f()
    const tc = toNorm({ x: mb.x, y: yTop, w: wpx, h: size * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: wpx / frame.w, fontSize: size / frame.w, align: 'left', colorRole: 'ink', blend: 'multiply', z: 1 })
    return { ops, did: `${sh ? sh.id : 'a shape'} in accent behind the title as a counter-form; title overprints it` }
  },
}
