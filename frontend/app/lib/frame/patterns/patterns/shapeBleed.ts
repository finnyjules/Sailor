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
    if (sh) {
      const wpx = frame.w * r.range(0.7, 1.05)
      const hpx = wpx * sh.aspect
      // hang the shape off `edge` so ~40% sits outside the frame
      let cx = frame.w / 2, cy = frame.h / 2
      if (edge === 'top') cy = hpx * 0.1
      else if (edge === 'bottom') cy = frame.h - hpx * 0.1
      else if (edge === 'left') cx = wpx * 0.1
      else cx = frame.w - wpx * 0.1
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: cx / frame.w, y: cy / frame.h, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
    }
    // title in the clear band opposite the bleed
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), mb.h / (1.2 * words.length))
    const blockH = size * 0.86 * words.length
    const clearTop = edge === 'top' ? frame.h - mb.y - blockH : mb.y
    const tc = toNorm({ x: mb.x, y: clearTop, w: mb.w, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    return { ops, did: `a ${sh ? sh.id : 'shape'} bleeding off the ${edge} edge, title clear of it` }
  },
}
