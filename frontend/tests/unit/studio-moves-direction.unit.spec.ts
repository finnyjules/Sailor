// frontend/tests/unit/studio-moves-direction.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { buildPairs, flipDirection, moveDirection } from '~/lib/studio/moves/direction'
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
describe('buildPairs direction/flip (authoritative, not the -in/In heuristic)', () => {
  const { direction, flip } = buildPairs({
    'slide-up': 'slide-out-up',
    'grow-in': 'shrink-in',
    'fade-in': 'fade-out',
  })
  it('classifies real Vector Type pairs correctly even when id text disagrees', () => {
    expect(direction('slide-up')).toBe('in')
    expect(direction('slide-out-up')).toBe('out')
    expect(direction('grow-in')).toBe('in')
    expect(direction('shrink-in')).toBe('out')
    expect(direction('wave')).toBeNull()
  })
  it('flips using the authoritative map', () => {
    expect(flip('slide-up')).toBe('slide-out-up')
    expect(flip('shrink-in')).toBe('grow-in')
  })
})
