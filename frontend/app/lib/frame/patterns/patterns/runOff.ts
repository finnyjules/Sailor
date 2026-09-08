import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, normLen, fitSize } from '../space'

export const runOff: Pattern = {
  id: 'runoff',
  name: 'Run-off',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 0)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const t = elements.title
    const scale = r.range(1.3, 2.0)                    // title width as a multiple of frame width
    const targetPx = frame.w * scale
    const text = t?.text ?? 'WORD'
    const sizePx = fitSize(text, targetPx, measure)
    const wpx = measure(text) * (sizePx / 100)         // actual title width in px
    const edge = r.pick(['left', 'right'] as const)
    // left: push the word left so its right end sits near the right margin.
    const xLeftPx = edge === 'left' ? -(wpx - (frame.w - mb.x)) : mb.x - (wpx - (frame.w - mb.x)) * r.range(0, 0.15)
    const slot = r.pick(['top', 'mid', 'bottom'] as const)
    const capH = sizePx * 0.72
    const yTopPx = slot === 'top' ? mb.y - capH * 0.08 : slot === 'mid' ? (frame.h - capH) / 2 : frame.h - mb.y - capH
    const centre = toNorm({ x: xLeftPx, y: yTopPx, w: wpx, h: capH }, frame)
    ops.push({
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: normLen(wpx, frame.w),
      fontSize: normLen(sizePx, frame.w),
      align: 'left', colorRole: 'ink',
    })
    // details + caption in the opposite corners from the title's slot.
    const detTop = slot !== 'top'
    if (elements.details) ops.push(cornerText('details', elements.details.text, detTop ? 'tl' : 'bl', ctx))
    if (elements.caption) ops.push(cornerText('caption', elements.caption.text, detTop ? 'tr' : 'br', ctx))
    return { ops, did: `title at ${Math.round(scale * 100)}% of the width, cropped by the ${edge} edge` }
  },
}

/** A small text op pinned to a margin corner. */
function cornerText(target: 'details' | 'caption', text: string, corner: 'tl' | 'tr' | 'bl' | 'br', ctx: import('../types').PatternContext): LayerOp {
  const { frame, margin } = ctx
  const mb = marginBox(frame, margin)
  const sizePx = frame.w * 0.024
  const wpx = mb.w * 0.42
  const right = corner.includes('r')
  const bottom = corner.includes('b')
  const xLeft = right ? mb.x + mb.w - wpx : mb.x
  const yTop = bottom ? mb.y + mb.h - sizePx : mb.y
  const centre = toNorm({ x: xLeft, y: yTop, w: wpx, h: sizePx }, frame)
  return {
    target, kind: 'text', x: centre.x, y: centre.y,
    w: wpx / frame.w, fontSize: sizePx / frame.w,
    align: right ? 'right' : 'left', colorRole: 'ink',
  }
}
