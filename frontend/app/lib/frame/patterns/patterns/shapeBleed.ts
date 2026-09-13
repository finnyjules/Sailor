import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const shapeBleed: Pattern = {
  id: 'shapeBleed',
  name: 'Bleed',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 14)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    const words = elements.title?.words ?? ['WORD']
    const edge = r.pick(['top', 'bottom', 'left', 'right'] as const)
    const horiz = edge === 'left' || edge === 'right'
    const gap = frame.w * 0.03
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const aspect = sh?.aspect ?? 1
    if (horiz) {
      const midX = frame.w * r.range(0.48, 0.58)       // the shape/title divide
      const wpx = frame.w * r.range(0.85, 1.1)
      const hpx = wpx * aspect
      // shape's INNER edge sits on the divide, the rest bleeds off its side
      const cx = edge === 'left' ? midX - wpx / 2 : (frame.w - midX) + wpx / 2
      if (sh) ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: cx / frame.w, y: 0.5, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
      // title in the OTHER half, starting a gap past the divide
      const colX = edge === 'left' ? midX + gap : mb.x
      const colRight = edge === 'left' ? frame.w - mb.x : frame.w - midX - gap
      const colW = colRight - colX
      const size = Math.min(fitSize(widest, colW, measure), mb.h / (1.2 * words.length))
      const blockH = size * 0.86 * words.length
      const tc = toNorm({ x: colX, y: (frame.h - blockH) / 2, w: colW, h: blockH }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: colW / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    } else {
      const midY = frame.h * r.range(0.48, 0.58)
      const wpx = frame.w * r.range(0.85, 1.1)
      const hpx = wpx * aspect
      const cy = edge === 'top' ? midY - hpx / 2 : (frame.h - midY) + hpx / 2
      if (sh) ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: 0.5, y: cy / frame.h, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
      // title in the OTHER band, full width, starting a gap past the divide
      const bandTop = edge === 'top' ? midY + gap : mb.y
      const bandBottom = edge === 'top' ? frame.h - mb.y : frame.h - midY - gap
      const bandH = bandBottom - bandTop
      const size = Math.min(fitSize(widest, mb.w, measure), bandH / (1.1 * words.length))
      const blockH = size * 0.86 * words.length
      const tc = toNorm({ x: mb.x, y: bandTop + (bandH - blockH) / 2, w: mb.w, h: blockH }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    }
    return { ops, did: `a ${sh ? sh.id : 'shape'} bleeding off the ${edge} edge, title clear of it` }
  },
}
