import { describe, it, expect } from 'vitest'
import { ghostAlphas } from '~/lib/scene3d/treatmentStage'

// CPU twin for the S6 ghost-trails fade (Task 3). Pure math, no WebGL: the same geometric
// falloff the stage's `ghostTrailsComposite` applies as the composite opacity for each past copy.
// alphas[i] is the opacity of the (i+1)-th ghost behind the object (fade^(i+1)); the crisp
// current object sits above them at the implicit fade^0 = 1.
describe('ghostAlphas', () => {
  it('is a geometric falloff fade^k, nearest-past first / oldest last', () => {
    expect(ghostAlphas(3, 0.5)).toEqual([0.5, 0.25, 0.125])
  })

  it('returns exactly `count` entries', () => {
    expect(ghostAlphas(1, 0.5)).toHaveLength(1)
    expect(ghostAlphas(8, 0.7)).toHaveLength(8)
  })

  it('is strictly decreasing for a fade in (0,1) — each ghost fainter than the one in front', () => {
    const a = ghostAlphas(5, 0.6)
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThan(a[i - 1]!)
  })

  it('every ghost is fainter than the crisp current object (implicit alpha 1)', () => {
    for (const a of ghostAlphas(6, 0.9)) expect(a).toBeLessThan(1)
  })

  it('fade 0 collapses every ghost to invisible (only the crisp object shows)', () => {
    expect(ghostAlphas(4, 0)).toEqual([0, 0, 0, 0])
  })

  it('fade 1 keeps every ghost at full opacity (a solid onion-skin stack)', () => {
    expect(ghostAlphas(4, 1)).toEqual([1, 1, 1, 1])
  })

  it('is empty for a zero count — no ghosts, no draws', () => {
    expect(ghostAlphas(0, 0.5)).toEqual([])
  })
})
