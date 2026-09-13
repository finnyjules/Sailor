import type { Pattern, LayerOp, Role } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const diagonal: Pattern = {
  id: 'diagonal',
  name: 'Diagonal',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 18)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const deg = r.pick([-45, -38, -32, 32, 38, 45] as const)
    const rad = Math.abs(deg) * Math.PI / 180
    const colW = mb.w * 0.62
    // small roles are stacked in a CLEAR band below the rotated title, never in a
    // corner the title can reach (a long, tall stacked title rotated 45° otherwise
    // dips into a corner detail — see the long-sentence test).
    const smalls = (['details', 'caption', 'date'] as Role[]).filter(role => elements[role])
    const smallSize = frame.w * 0.022
    const gap = frame.w * 0.03
    const bandH = smalls.length ? smalls.length * smallSize * 1.4 + gap : 0
    // cap the title so its ROTATED half-height leaves the bottom band clear:
    //   rotatedHalfH = (colW/2)·sin + (blockH/2)·cos ≤ frame.h/2 − mb.y − bandH
    const availHalfH = Math.max(frame.w * 0.1, frame.h / 2 - mb.y - bandH)
    let size = Math.min(fitSize(widest, colW, measure), mb.h / (1.05 * words.length))
    const capBySin = (availHalfH - (colW / 2) * Math.sin(rad)) / Math.max(1e-3, (0.86 * words.length / 2) * Math.cos(rad))
    if (capBySin > 0) size = Math.min(size, capBySin)
    const blockH = size * 0.86 * words.length
    const tc = toNorm({ x: mb.x + (mb.w - colW) / 2, y: (frame.h - blockH) / 2, w: colW, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: tc.x, y: tc.y,
      w: colW / frame.w, fontSize: size / frame.w,
      align: 'center', rotation: deg, lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // stack the small roles in the clear band below the title's rotated bottom edge
    const rotatedHalfH = (colW / 2) * Math.sin(rad) + (blockH / 2) * Math.cos(rad)
    let y = frame.h / 2 + rotatedHalfH + gap
    const wpx = mb.w * 0.5
    for (const role of smalls) {
      const cc = toNorm({ x: mb.x + (mb.w - wpx) / 2, y, w: wpx, h: smallSize }, frame)
      ops.push({ target: role, kind: 'text', x: cc.x, y: cc.y, w: wpx / frame.w, fontSize: smallSize / frame.w, align: 'center', colorRole: 'ink' })
      y += smallSize * 1.4
    }
    return { ops, did: `title on a ${Math.abs(deg)}-degree diagonal, details below` }
  },
}
