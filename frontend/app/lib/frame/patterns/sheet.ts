import type { PatternContext, Pattern, PatternPlacement } from './types'
import { fittingPatterns } from './catalog'

export interface Tile { patternId: string; name: string; seed: number; did: string; ops: PatternPlacement['ops'] }

/** One tile: a pattern run at a seed. The context's seed is overridden per tile. */
export function tileFor(ctx: PatternContext, pattern: Pattern, seed: number): Tile {
  const out = pattern.place({ ...ctx, seed })
  return { patternId: pattern.id, name: pattern.name, seed, did: out.did, ops: out.ops }
}

/** The contact sheet: one tile per pattern that fits what the frame holds. */
export function sheetFor(ctx: PatternContext, seed: number): Tile[] {
  return fittingPatterns(ctx).map(p => tileFor(ctx, p, seed))
}

/** "More like this": n tiles of one pattern at spread-out seeds. */
export function variantsFor(ctx: PatternContext, pattern: Pattern, seed: number, n: number): Tile[] {
  return Array.from({ length: n }, (_, k) => tileFor(ctx, pattern, seed + (k + 1) * 101))
}
