import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A small eyebrow label tight above a big one-line title, both centred. */
export const kicker: Pattern = {
  id: 'kicker',
  name: 'Kicker',
  fits: ['phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 24)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const line = words.join(' ')
    // Title fitted to the margin width on one line, capped so it leaves room for the eyebrow.
    const titlePx = Math.min(fitSize(line, mb.w, measure), mb.h * 0.34)
    const eyebrowEl = elements.caption ?? elements.date ?? elements.details
    const eyebrowPx = Math.min(titlePx * 0.16, mb.h * 0.06)
    const gap = mb.h * 0.04
    // Centre the (eyebrow + gap + title) group in the margin box.
    const groupH = (eyebrowEl ? eyebrowPx + gap : 0) + titlePx
    const top = mb.y + (mb.h - groupH) / 2
    const ops: LayerOp[] = []
    if (eyebrowEl) {
      const ec = toNorm({ x: mb.x, y: top, w: mb.w, h: eyebrowPx }, frame)
      ops.push({ target: eyebrowEl.role, kind: 'text', x: ec.x, y: ec.y, w: mb.w / frame.w, fontSize: eyebrowPx / frame.w, align: 'center', colorRole: 'ink' })
    }
    const titleTop = top + (eyebrowEl ? eyebrowPx + gap : 0)
    const tc = toNorm({ x: mb.x, y: titleTop, w: mb.w, h: titlePx }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: titlePx / frame.w, align: 'center', colorRole: 'ink' })
    void r
    return { ops, did: 'a small eyebrow above a big centred title' }
  },
}
