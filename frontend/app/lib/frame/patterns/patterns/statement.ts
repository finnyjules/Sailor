import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const statement: Pattern = {
  id: 'statement',
  name: 'Statement',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 1)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    // fit the widest word to the margin width
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const widthFit = fitSize(widest, mb.w, measure)
    const heightFit = mb.h / (0.86 * words.length)
    const sizePx = Math.min(widthFit, heightFit)
    const capH = sizePx * 0.86
    const blockH = capH * words.length
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const align = r.pick(['left', 'center', 'right'] as const)
    const centre = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align, lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    if (elements.details) ops.push(cornerText('details', top ? 'bl' : 'tl', ctx))
    if (elements.caption) ops.push(cornerText('caption', top ? 'br' : 'tr', ctx))
    return { ops, did: `title fitted to the margins, one word per line, ${align}, ${top ? 'top' : 'bottom'}` }
  },
}

function cornerText(target: 'details' | 'caption', corner: 'tl' | 'tr' | 'bl' | 'br', ctx: import('../types').PatternContext): LayerOp {
  const { frame, margin } = ctx
  const mb = marginBox(frame, margin)
  const sizePx = frame.w * 0.024
  const wpx = mb.w * 0.42
  const right = corner.includes('r'); const bottom = corner.includes('b')
  const xLeft = right ? mb.x + mb.w - wpx : mb.x
  const yTop = bottom ? mb.y + mb.h - sizePx : mb.y
  const c = toNorm({ x: xLeft, y: yTop, w: wpx, h: sizePx }, frame)
  return { target, kind: 'text', x: c.x, y: c.y, w: wpx / frame.w, fontSize: sizePx / frame.w, align: right ? 'right' : 'left', colorRole: 'ink' }
}
