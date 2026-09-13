import { describe, it, expect } from 'vitest'
import { pickShape } from '~/lib/frame/patterns/shapePick'
import { rngFor } from '~/lib/frame/patterns/rng'
import { familyOf, shapeById } from '~/lib/shapes/catalog'
import type { FrameElements } from '~/lib/frame/patterns/types'

const base: FrameElements = { images: [], shapes: [], shapeMode: null, imageMode: false }

describe('pickShape', () => {
  it('returns null when nothing is chosen', () => {
    expect(pickShape(base, rngFor(1, 0))).toBeNull()
  })
  it('prefers a placed shape element', () => {
    const s = pickShape({ ...base, shapes: [{ id: 'x', shapeId: 'circle' }] }, rngFor(1, 0))
    expect(s?.id).toBe('circle')
    const box = shapeById('circle')!.box
    expect(s?.aspect).toBeCloseTo(box[3] / box[2], 6)
  })
  it('uses a specific shapeMode id', () => {
    expect(pickShape({ ...base, shapeMode: { id: 'sun-rays' } }, rngFor(1, 0))?.id).toBe('sun-rays')
  })
  it('picks within a family, deterministically, and it belongs to that family', () => {
    const a = pickShape({ ...base, shapeMode: { family: 'suns' } }, rngFor(5, 2))
    const b = pickShape({ ...base, shapeMode: { family: 'suns' } }, rngFor(5, 2))
    expect(a?.id).toBe(b?.id)
    expect(familyOf(a!.id)).toBe('suns')
  })
})
