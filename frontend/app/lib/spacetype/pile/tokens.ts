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
  const worldPerPx = (2 * FRAME_HALF_H) / Math.max(1, frame.height)
  const specs: PileTokenSpec[] = []
  let fillIndex = 0

  const textAs = str(params, 'textAs', 'words')
  const text = str(params, 'text')
  if (textAs === 'words') {
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const h = num(params, 'typeSize', 200) * worldPerPx
      const w = h * TEXT_ADVANCE * Math.max(1, word.length)
      specs.push({ kind: 'word', text: word, w, h, fillIndex: fillIndex++ })
    }
  } else if (textAs === 'letters') {
    for (const ch of [...text]) {
      if (/\s/.test(ch)) continue
      const h = num(params, 'typeSize', 200) * worldPerPx
      const w = h * TEXT_ADVANCE
      specs.push({ kind: 'letter', text: ch, w, h, fillIndex: fillIndex++ })
    }
  }

  const shapeCount = Math.max(0, Math.round(num(params, 'shapeCount')))
  if (shapeCount > 0) {
    const shapeId = str(params, 'shape', 'none')
    const chosen = shapeId && shapeId !== 'none' ? shapeId : (SHAPES[0]?.id ?? 'none')
    const shape = SHAPES.find(s => s.id === chosen)
    const aspect = shape ? shapeAspect(shape) : 1 // width / height
    const baseH = num(params, 'shapeSize', 120) * worldPerPx
    const variation = Math.min(0.95, Math.max(0, num(params, 'sizeVariation')))
    for (let i = 0; i < shapeCount; i++) {
      const jitter = 1 + (rng() * 2 - 1) * variation
      const h = baseH * jitter
      specs.push({ kind: 'shape', shapeId: chosen, w: h * aspect, h, fillIndex: fillIndex++ })
    }
  }

  return specs
}
