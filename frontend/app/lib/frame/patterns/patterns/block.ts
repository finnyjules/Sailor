import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm } from '../space'

export const block: Pattern = {
  id: 'block',
  name: 'Block',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 12)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const text = elements.title?.text ?? 'WORD'
    const colWpx = mb.w * r.range(0.62, 0.9)
    // A justified running block wraps inside the column; its height grows roughly
    // quadratically with the font size (taller glyphs AND more wrapped lines). Size
    // the text off the real measured run so a long title cannot overflow the page:
    // blockH(size) ≈ 1.15·size·lines, lines ≈ (measure(text)·size/100)/colWpx, so
    // blockH ≈ C·size²; the size whose block just fills mb.h is sqrt(mb.h / C).
    const at100 = measure(text) || 1
    const C = (at100 / 100 / colWpx) * 1.15
    const fitSizePx = Math.sqrt(mb.h / C)
    const sizePx = Math.min(frame.w * r.range(0.05, 0.08), fitSizePx)
    const lines = Math.max(1, Math.ceil((at100 * sizePx / 100) / colWpx))
    const blockH = Math.min(sizePx * 1.15 * lines, mb.h)
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
