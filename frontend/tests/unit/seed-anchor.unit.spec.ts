import { describe, it, expect } from 'vitest'
import { anchorOne, anchorTwo, applyVariation } from '~/lib/color/anchor'

const entry = { s: 0 as const, c: ['#69d2e7', '#a7dbd8', '#e0e4cc', '#f38630', '#fa6900'] }

describe('re-anchoring', () => {
  it('puts the seed hex verbatim into the result', () => {
    const r = anchorOne(entry, '#b64a1f')
    expect(r.hexes[r.anchorIdx]).toBe('#b64a1f')
  })
  it('keeps the palette length', () => {
    expect(anchorOne(entry, '#b64a1f').hexes).toHaveLength(5)
  })
  it('every output is a valid hex', () => {
    for (const h of anchorOne(entry, '#123456').hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('two-seed anchoring lands both seeds verbatim', () => {
    const r = anchorTwo(entry, '#b64a1f', '#2545d3')
    expect(r.hexes[r.anchorIdxs[0]!]).toBe('#b64a1f')
    expect(r.hexes[r.anchorIdxs[1]!]).toBe('#2545d3')
  })
  it('variation leaves anchors untouched (hard-anchor invariant)', () => {
    const r = anchorOne(entry, '#b64a1f')
    const v = applyVariation(r.hexes, [r.anchorIdx], 0.8, 'key')
    expect(v[r.anchorIdx]).toBe('#b64a1f')
  })
  it('variation is deterministic for a key', () => {
    const r = anchorOne(entry, '#b64a1f')
    const a = applyVariation(r.hexes, [r.anchorIdx], 0.5, 'k')
    const b = applyVariation(r.hexes, [r.anchorIdx], 0.5, 'k')
    expect(a).toEqual(b)
  })
})
