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
import { diagonal } from './patterns/diagonal'
import { wall } from './patterns/wall'
import { scatter } from './patterns/scatter'
import { cascade } from './patterns/cascade'
import { ring } from './patterns/ring'
import { cells } from './patterns/cells'
import { kicker } from './patterns/kicker'
import { sidebar } from './patterns/sidebar'
import { footer } from './patterns/footer'

import { LAYOUTS } from './layouts/catalog'

/** The old engine's per-pattern placements, by id. Only the old sheet (`sheet.ts`) still calls
 *  `place`; the plan and apply run the layout kit (`applyToFrame.ts` → `kit/plan.ts`). */
const OLD_PLACE = new Map<string, Pattern>([runOff, statement, indexPattern, shapeCounter, photoBehind, fullBleed, tilt, bottomHeavy, fourCorners, spacedLines, ragged, edges, staircase, block, knockout, shapeBleed, badge, split, diagonal, wall, scatter, cascade, ring, cells, kicker, sidebar, footer].map(p => [p.id, p]))

/** Every layout in the kit's catalog (`layouts/catalog.ts`, all 42, in its order), in the old
 *  `Pattern` shape so the name/id consumers keep working. `place` runs the old engine where the
 *  layout had an old pattern; a layout new with the kit has no old placement (empty ops) — its
 *  plan comes from the kit. */
export const PATTERNS: Pattern[] = LAYOUTS.map((l): Pattern => {
  const old = OLD_PLACE.get(l.id)
  return {
    id: l.id,
    name: l.name,
    fits: [...l.fits],
    needs: l.needs,
    place: old ? ctx => old.place(ctx) : () => ({ ops: [], did: l.name }),
  }
})

/** "Number-like": a price, a discount, a date or a time (the kit's `needs.number` test, as in
 *  `kit/plan.ts`). */
const isNumberish = (s: string | undefined) =>
  !!s && (/[%€$£]/.test(s) || s.replace(/\D/g, '').length / Math.max(1, s.replace(/\s/g, '').length) >= 0.3)

/** Layouts that fit the title's kind and whose required elements are present. */
export function fittingPatterns(ctx: PatternContext): Pattern[] {
  const kind = kindOf(ctx.elements.title?.words.length ?? 0)
  const hasShape = ctx.elements.shapes.length > 0 || ctx.elements.shapeMode != null
  const hasImage = ctx.elements.images.length > 0 || ctx.elements.imageMode
  return PATTERNS.filter(p => {
    if (!p.fits.includes(kind)) return false
    if (p.needs?.shape && !hasShape) return false
    if (p.needs?.image && !hasImage) return false
    if ((p.needs as { number?: boolean } | undefined)?.number && !isNumberish(ctx.elements.date?.text)) return false
    return true
  })
}
