import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const wall: Pattern = {
  id: 'wall',
  name: 'Wall',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 19)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const wpl = r.pick([2, 3] as const)
    const lines = Math.max(1, Math.ceil(words.length / wpl))
    // pack the title edge-to-edge: expressive with BOTH axes justified so the
    // words fill the width per line and the bands fill the height (distinct from
    // Spaced lines, which justifies the height only, one word per band).
    const size = Math.min(fitSize(widest, mb.w / wpl, measure), mb.h / (1.05 * lines))
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      align: 'justify', valign: 'justify', colorRole: 'ink',
      // placement is inert while both axes justify (justifyX/Y override it) — kept a valid enum.
      expressive: { wordsPerLine: wpl, placement: 'edges', jitterX: 0, jitterY: 0, seed: ctx.seed | 0 },
    }]
    return { ops, did: 'title packed edge to edge as a wall' }
  },
}
