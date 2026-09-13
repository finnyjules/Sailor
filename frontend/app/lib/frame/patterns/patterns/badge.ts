import type { Pattern, LayerOp, Role } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const badge: Pattern = {
  id: 'badge',
  name: 'Badge',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 15)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    // badge in a top corner
    const right = r.chance(0.5)
    let badgeBox = { x: mb.x, y: mb.y, w: 0, h: 0 }
    if (sh) {
      const wpx = frame.w * r.range(0.2, 0.32)
      const hpx = wpx * sh.aspect
      const xLeft = right ? mb.x + mb.w - wpx : mb.x
      const sc = toNorm({ x: xLeft, y: mb.y, w: wpx, h: hpx }, frame)
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: sc.x, y: sc.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
      badgeBox = { x: xLeft, y: mb.y, w: wpx, h: hpx }
      // a small piece of text reversed inside the badge: prefer date, else caption
      const inner: Role | null = elements.date ? 'date' : elements.caption ? 'caption' : null
      if (inner) {
        const s = Math.min(frame.w * 0.03, hpx * 0.4)
        const ic = toNorm({ x: xLeft, y: mb.y + (hpx - s) / 2, w: wpx, h: s }, frame)
        ops.push({ target: inner, kind: 'text', x: ic.x, y: ic.y, w: wpx / frame.w, fontSize: s / frame.w, align: 'center', colorRole: 'field', z: 1 })
      }
    }
    // the title set large, below the badge, in the open space
    const words = elements.title?.words ?? ['WORD']
    const top = badgeBox.y + badgeBox.h + frame.w * 0.04
    const availH = frame.h - mb.y - top
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), availH / (1.15 * words.length))
    const tc = toNorm({ x: mb.x, y: top, w: mb.w, h: size * 0.86 * words.length }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 2 })
    return { ops, did: `a ${sh ? sh.id : 'shape'} badge with the ${elements.date ? 'date' : 'details'} reversed; title large below` }
  },
}
