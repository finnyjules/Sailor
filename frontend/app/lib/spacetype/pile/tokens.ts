import type { Params } from '../effect'
import { mulberry32, hashSeed } from '../rng'
import { SHAPES } from '~/lib/shapes/catalog'
import { shapeAspect } from '~/lib/shapes/path2d'
import { FRAME_HALF_H } from './physics'

export interface PileTokenSpec {
  kind: 'word' | 'letter' | 'shape'
  text?: string          // word or single letter (kinds word/letter)
  shapeId?: string       // library shape id (kind shape)
  w: number              // OUTER extents in world units (collider is w/2, h/2 half-extents)
  h: number
  fillIndex: number      // index into the fills list (cycled)
}

const num = (p: Params, k: string, d = 0): number => { const v = Number(p[k]); return Number.isFinite(v) ? v : d }
const str = (p: Params, k: string, d = ''): string => (p[k] == null ? d : String(p[k]))

// Rough advance width for a text string at height 1 (world), before per-glyph
// canvas measurement. Physics colliders and the fitted mesh use this same estimate,
// so text and box stay consistent even though it is approximate.
const TEXT_ADVANCE = 0.62 // avg glyph width / cap height for condensed display faces

/**
 * Turn params into a deterministic list of token specs (what falls, and how big).
 * Two additive sources: the phrase as words OR letters, plus library shapes.
 * Pure — no canvas, no three, no physics — so it is fully unit-testable.
 */
export function planPileTokens(params: Params, frame: { width: number; height: number }): PileTokenSpec[] {
  const rng = mulberry32(hashSeed(`${str(params, 'text')}|${num(params, 'seed')}|pile`))
  // Camera zoom (Transform → Scale) shrinks the visible frame to ±FRAME_HALF_H/scale; size and
  // clamp tokens against the VISIBLE frame so they fit and settle within the canvas. Mirrors physics.ts.
  const halfH = FRAME_HALF_H / Math.max(0.1, num(params, 'scale', 1))
  const worldPerPx = (2 * halfH) / Math.max(1, frame.height)
  const specs: PileTokenSpec[] = []
  let fillIndex = 0

  // A token must fit inside the container, or it wedges between the walls and never
  // falls (looks like it vanished). Clamp every token to the container width and most
  // of the frame height, scaling it down UNIFORMLY so text/shapes keep their aspect.
  const frameAspect = Math.max(0.1, frame.width / Math.max(1, frame.height))
  const containerHalfW = Math.max(0.2, num(params, 'container', 0.8)) * halfH * frameAspect
  const maxW = containerHalfW * 2 * 0.9
  // Cap a single token to ~45% of the frame height so a couple of stacked tokens still
  // fit in view (the pile builds up from the floor; without this, big type overflows
  // the top and the pile reads as "gone").
  const maxH = halfH * 0.9
  const fit = (w: number, h: number): [number, number] => {
    const s = Math.min(1, maxW / Math.max(1e-4, w), maxH / Math.max(1e-4, h))
    return [w * s, h * s]
  }

  const textAs = str(params, 'textAs', 'words')
  const text = str(params, 'text')
  if (textAs === 'words') {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const h0 = num(params, 'typeSize', 200) * worldPerPx
      const [w, h] = fit(h0 * TEXT_ADVANCE * Math.max(1, word.length), h0)
      specs.push({ kind: 'word', text: word, w, h, fillIndex: fillIndex++ })
    }
  } else if (textAs === 'letters') {
    for (const ch of [...text]) {
      if (/\s/.test(ch)) continue
      const h0 = num(params, 'typeSize', 200) * worldPerPx
      const [w, h] = fit(h0 * TEXT_ADVANCE, h0)
      specs.push({ kind: 'letter', text: ch, w, h, fillIndex: fillIndex++ })
    }
  }

  const shapeCount = Math.max(0, Math.round(num(params, 'shapeCount')))
  if (shapeCount > 0) {
    const set = shapeIdSet(params)
    const baseH = num(params, 'shapeSize', 120) * worldPerPx
    const variation = Math.min(0.95, Math.max(0, num(params, 'sizeVariation')))
    for (let i = 0; i < shapeCount; i++) {
      const chosen = set[Math.floor(rng() * set.length)] ?? set[0]!
      const shape = SHAPES.find(s => s.id === chosen)
      const aspect = shape ? shapeAspect(shape) : 1 // width / height
      const jitter = 1 + (rng() * 2 - 1) * variation
      const h1 = baseH * jitter
      const [w, h] = fit(h1 * aspect, h1)
      specs.push({ kind: 'shape', shapeId: chosen, w, h, fillIndex: fillIndex++ })
    }
  }

  return specs
}

/** The hand-picked shape ids (params.shapes = JSON array), filtered to real catalog ids.
 *  Falls back to a legacy single `shape`, then to the first catalog shape — so the pile is
 *  never empty when Shape count > 0 but nothing is picked. */
function shapeIdSet(params: Params): string[] {
  const valid = (id: unknown): id is string => typeof id === 'string' && id !== 'none' && SHAPES.some(s => s.id === id)
  let ids: string[] = []
  try {
    const parsed = JSON.parse(str(params, 'shapes', '[]'))
    if (Array.isArray(parsed)) ids = parsed.filter(valid)
  } catch { /* fall through to legacy/default */ }
  if (!ids.length) { const legacy = str(params, 'shape', 'none'); if (valid(legacy)) ids = [legacy] }
  if (!ids.length && SHAPES[0]) ids = [SHAPES[0].id]
  return ids
}
