import type { Pattern, PatternContext } from './types'
import { kindOf } from './types'
import { runOff } from './patterns/runOff'
import { statement } from './patterns/statement'
import { indexPattern } from './patterns/indexPattern'
import { shapeCounter } from './patterns/shapeCounter'
import { photoBehind } from './patterns/photoBehind'
import { fullBleed } from './patterns/fullBleed'
import { tilt } from './patterns/tilt'
import { bottomHeavy } from './patterns/bottomHeavy'
import { fourCorners } from './patterns/fourCorners'
import { spacedLines } from './patterns/spacedLines'
import { ragged } from './patterns/ragged'
import { edges } from './patterns/edges'
import { staircase } from './patterns/staircase'
import { block } from './patterns/block'
import { knockout } from './patterns/knockout'
import { shapeBleed } from './patterns/shapeBleed'
import { badge } from './patterns/badge'
import { split } from './patterns/split'

export const PATTERNS: Pattern[] = [runOff, statement, indexPattern, shapeCounter, photoBehind, fullBleed, tilt, bottomHeavy, fourCorners, spacedLines, ragged, edges, staircase, block, knockout, shapeBleed, badge, split]

/** Patterns that fit the title's kind and whose required elements are present. */
export function fittingPatterns(ctx: PatternContext): Pattern[] {
  const kind = kindOf(ctx.elements.title?.words.length ?? 0)
  const hasShape = ctx.elements.shapes.length > 0 || ctx.elements.shapeMode != null
  const hasImage = ctx.elements.images.length > 0 || ctx.elements.imageMode
  return PATTERNS.filter(p => {
    if (!p.fits.includes(kind)) return false
    if (p.needs?.shape && !hasShape) return false
    if (p.needs?.image && !hasImage) return false
    return true
  })
}
