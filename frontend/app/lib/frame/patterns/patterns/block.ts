import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm } from '../space'

export const block: Pattern = {
  id: 'block',
  name: 'Block',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 12)
    const { frame, margin, elements } = ctx
    const mb = marginBox(frame, margin)
    // a running-text block: a chunky size, justified, wrapped inside a column.
    const colWpx = mb.w * r.range(0.62, 0.9)
    const sizePx = frame.w * r.range(0.055, 0.085)
    // estimate the wrapped height from the title's character count so we can top-
    // or centre-anchor without measuring per line (measurement is the layer's job).
    const chars = (elements.title?.text ?? 'WORD').length
    const perLine = Math.max(1, Math.floor(colWpx / (sizePx * 0.5)))
    const lines = Math.max(1, Math.ceil(chars / perLine))
    const blockH = sizePx * 1.15 * lines
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const c = toNorm({ x: mb.x, y: yTop, w: colWpx, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: colWpx / frame.w, fontSize: sizePx / frame.w,
      align: 'justify', colorRole: 'ink',
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dy = top ? mb.y + mb.h - s : mb.y
      const dc = toNorm({ x: mb.x, y: dy, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title set as a justified block, ${top ? 'top' : 'bottom'}` }
  },
}
