import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize, snapX } from '../space'

export const indexPattern: Pattern = {
  id: 'index',
  name: 'Index',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 2)
    const { frame, margin, grid, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []

    // title top-left, fitted to a fraction of the width
    const tText = elements.title?.text ?? 'WORD'
    const tSize = fitSize(tText, mb.w * r.range(0.5, 0.72), measure)
    const tWpx = measure(tText) * (tSize / 100)
    const tc = toNorm({ x: mb.x, y: mb.y - tSize * 0.06, w: tWpx, h: tSize * 0.72 }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: tWpx / frame.w, fontSize: tSize / frame.w, align: 'left', colorRole: 'ink' })

    // details ruled on the right; left edge snapped to a grid line when present
    if (elements.details) {
      const rawX = frame.w * 0.58
      const colX = snapX(rawX, grid)
      const colW = (frame.w - margin * frame.w) - colX
      const dSize = frame.w * 0.024
      const dc = toNorm({ x: colX, y: mb.y, w: colW, h: dSize }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: colW / frame.w, fontSize: dSize / frame.w, align: 'left', colorRole: 'ink' })
    }

    // the date set large at the foot, in accent
    if (elements.date) {
      const dText = elements.date.text
      const dSize = Math.min(fitSize(dText, mb.w, measure), frame.h * r.range(0.1, 0.18))
      const dWpx = measure(dText) * (dSize / 100)
      const dc = toNorm({ x: mb.x, y: frame.h - mb.y - dSize * 0.72, w: dWpx, h: dSize * 0.72 }, frame)
      ops.push({ target: 'date', kind: 'text', x: dc.x, y: dc.y, w: dWpx / frame.w, fontSize: dSize / frame.w, align: 'left', colorRole: 'accent' })
    }

    if (elements.caption) {
      const cSize = frame.w * 0.019
      const cc = toNorm({ x: mb.x, y: frame.h - mb.y - cSize, w: mb.w * 0.42, h: cSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.42) / frame.w, fontSize: cSize / frame.w, align: 'left', colorRole: 'ink' })
    }

    return { ops, did: 'title top-left; details ruled on the right; the date large at the foot in accent' }
  },
}
