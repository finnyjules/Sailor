import type { FrameElements } from './types'
import type { PatternRng } from './rng'
import { SHAPES, shapeById, familyOf } from '~/lib/shapes/catalog'

const withAspect = (id: string) => {
  const sh = shapeById(id)
  if (!sh) return null
  return { id, aspect: sh.box[3] / sh.box[2] }
}

/** A placed shape wins; else a specific shapeMode id; else a seeded pick from a
 *  family. Returns the shape id + its ink-box aspect (h/w), or null. */
export function pickShape(elements: FrameElements, rng: PatternRng): { id: string; aspect: number } | null {
  if (elements.shapes.length) return withAspect(elements.shapes[0]!.shapeId)
  const mode = elements.shapeMode
  if (!mode) return null
  if ('id' in mode) return withAspect(mode.id)
  const pool = SHAPES.filter(s => familyOf(s.id) === mode.family)
  if (!pool.length) return null
  return withAspect(rng.pick(pool).id)
}
