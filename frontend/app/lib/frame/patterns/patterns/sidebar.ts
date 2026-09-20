import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A big title in a left column, the small texts stacked in a right column. */
export const sidebar: Pattern = {
  id: 'sidebar',
  name: 'Sidebar',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 25)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const gap = mb.w * 0.05
    const colW = mb.w * 0.6
    const sideX = mb.x + colW + gap
    const sideW = mb.x + mb.w - sideX
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const size = Math.min(fitSize(widest, colW, measure), mb.h / (1.15 * words.length))
    const c = toNorm({ x: mb.x, y: mb.y, w: colW, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: colW / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      align: 'left', colorRole: 'ink',
    }]
    const side = [elements.details, elements.date, elements.caption].filter(Boolean) as { role: string }[]
    const rowH = Math.min(mb.h * 0.06, sideW * 0.16)
    let y = mb.y + rowH / 2
    for (const el of side) {
      const sc = toNorm({ x: sideX, y: y - rowH / 2, w: sideW, h: rowH }, frame)
      ops.push({ target: el.role as any, kind: 'text', x: sc.x, y: sc.y, w: sideW / frame.w, fontSize: rowH * 0.7 / frame.w, align: 'left', colorRole: 'ink' })
      y += rowH * 1.5
    }
    void r
    return { ops, did: 'title column beside a details column' }
  },
}
