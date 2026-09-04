// frontend/tests/unit/studio-moves-direction.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { flipDirection, moveDirection } from '~/lib/studio/moves/direction'
const PAIRS = { 'fade-in': 'fade-out', 'fade-out': 'fade-in' }
describe('direction', () => {
  it('reads and flips a paired preset', () => {
    expect(moveDirection('fade-in', PAIRS)).toBe('in')
    expect(moveDirection('fade-out', PAIRS)).toBe('out')
    expect(flipDirection('fade-in', PAIRS)).toBe('fade-out')
  })
  it('returns null for an unpaired preset', () => {
    expect(moveDirection('wave', PAIRS)).toBeNull()
    expect(flipDirection('wave', PAIRS)).toBe('wave')
  })
})
