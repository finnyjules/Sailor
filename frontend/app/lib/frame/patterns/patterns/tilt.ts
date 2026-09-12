import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm } from '../space'

export const tilt: Pattern = {
  id: 'tilt',
  name: 'Tilt',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 5)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const at100 = measure(widest) || 1
    // fit the widest word to ~60% of the margin width, and bound the stacked
    // block to the margin height so a tall stack cannot overrun the page.
    const widthFit = (100 * (mb.w * 0.6)) / at100
    const heightFit = mb.h / (0.9 * words.length)
    const sizePx = Math.min(widthFit, heightFit)
    const blockH = sizePx * 0.86 * words.length
    const deg = r.pick([-12, -9, -6, 6, 9, 12] as const)
    const centre = toNorm({ x: mb.x + (mb.w - mb.w * 0.6) / 2, y: (frame.h - blockH) / 2, w: mb.w * 0.6, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: (mb.w * 0.6) / frame.w, fontSize: sizePx / frame.w,
      align: 'center', rotation: deg,
      lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // one small anchor line, unrotated, in a bottom corner
    const anchor = elements.details ?? elements.caption ?? elements.date
    if (anchor) {
      const sizePx2 = frame.w * 0.022
      const wpx = mb.w * 0.4
      const c = toNorm({ x: mb.x, y: mb.y + mb.h - sizePx2, w: wpx, h: sizePx2 }, frame)
      ops.push({ target: anchor.role, kind: 'text', x: c.x, y: c.y, w: wpx / frame.w, fontSize: sizePx2 / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title tilted ${Math.abs(deg)} degrees, stacked` }
  },
}
