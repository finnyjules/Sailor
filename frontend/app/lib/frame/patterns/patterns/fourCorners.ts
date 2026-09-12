import type { Pattern, LayerOp, Role } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const
type Corner = typeof CORNERS[number]

export const fourCorners: Pattern = {
  id: 'fourCorners',
  name: 'Four corners',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 7)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.55, measure), mb.h / (1.1 * words.length))
    const blockH = sizePx * 0.86 * words.length
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'center', lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // the present small roles fill corners in a rotated order (seed picks the start)
    const roles = (['details', 'date', 'caption'] as Role[]).filter(role => elements[role])
    const start = r.int(0, 3)
    const smallSize = frame.w * 0.022
    const wpx = mb.w * 0.4
    roles.forEach((role, i) => {
      const corner: Corner = CORNERS[(start + i) % 4]!
      const right = corner.includes('r')
      const bottom = corner.includes('b')
      const xLeft = right ? mb.x + mb.w - wpx : mb.x
      const yTop = bottom ? mb.y + mb.h - smallSize : mb.y
      const cc = toNorm({ x: xLeft, y: yTop, w: wpx, h: smallSize }, frame)
      ops.push({ target: role, kind: 'text', x: cc.x, y: cc.y, w: wpx / frame.w, fontSize: smallSize / frame.w, align: right ? 'right' : 'left', colorRole: 'ink' })
    })
    return { ops, did: 'title centred, the details set into the corners' }
  },
}
