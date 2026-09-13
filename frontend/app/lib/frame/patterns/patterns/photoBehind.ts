import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const photoBehind: Pattern = {
  id: 'photoBehind',
  name: 'Photo behind',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 4)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    // title upper-ish, oversize
    const text = elements.title?.text ?? 'WORD'
    const size = fitSize(text, mb.w * r.range(1.1, 1.6), measure)
    const wpx = measure(text) * (size / 100)
    const tyTop = mb.y + mb.h * r.range(0, 0.25)
    const tc = toNorm({ x: mb.x, y: tyTop, w: wpx, h: size * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: wpx / frame.w, fontSize: size / frame.w, align: 'left', colorRole: 'ink', z: 1 })
    // image behind, covering the title's lower part down to the foot
    const pyTop = tyTop + size * 0.4
    const full = r.chance(0.5)
    const pxLeft = full ? 0 : mb.x
    const pw = full ? frame.w : mb.w
    const c = toNorm({ x: pxLeft, y: pyTop, w: pw, h: frame.h - pyTop }, frame)
    ops.push({ target: elements.images[0]?.id ?? 'image', kind: 'image', x: c.x, y: c.y, w: pw / frame.w, h: (frame.h - pyTop) / frame.w, fill: 'photo', z: 0 })
    if (elements.caption) {
      const cSize = frame.w * 0.019
      const cc = toNorm({ x: mb.x, y: frame.h - mb.y - cSize, w: mb.w * 0.42, h: cSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.42) / frame.w, fontSize: cSize / frame.w, align: 'left', colorRole: 'field', z: 2 })
    }
    return { ops, did: 'the title sits behind the photo, its lower part hidden' }
  },
}
