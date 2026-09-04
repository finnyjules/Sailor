// frontend/tests/unit/studio-moves-phase.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { movePhase, moveWindows } from '~/lib/studio/moves/phase'
import type { Move } from '~/lib/studio/moves/types'
const mk = (o: Partial<Move>): Move => ({ id: 'x', kind: 'preset', presetId: 'p', at: 0, duration: 1, loop: false, ease: { kind: 'named', name: 'none' }, ...o })
describe('at-anchored windows', () => {
  it('a transition is live only inside [at, at+duration]', () => {
    const m = mk({ at: 1, duration: 0.5 })
    expect(movePhase(m, 1.25, 4)).toBeCloseTo(0.5, 6)
    expect(movePhase(m, 0.9, 4)).toBeNull()
    expect(movePhase(m, 1.6, 4)).toBeNull()
  })
  it('a loop runs [at, clip] and wraps continuously', () => {
    const m = mk({ at: 1, duration: 1, loop: true })
    expect(movePhase(m, 1.0, 4)).toBeCloseTo(0, 6)
    expect(movePhase(m, 1.5, 4)).toBeCloseTo(0.5, 6)
    expect(movePhase(m, 2.0, 4)).toBeCloseTo(0, 6)
    expect(movePhase(m, 0.9, 4)).toBeNull()
  })
  it('bounce ping-pongs within the window', () => {
    const m = mk({ at: 0, duration: 1, bounce: true })
    expect(movePhase(m, 0.5, 4)).toBeCloseTo(1, 6)
    expect(movePhase(m, 1.0 - 1e-9, 4)).toBeCloseTo(0, 4)
  })
  it('moveWindows returns at→end, end=clip for a loop', () => {
    const ws = moveWindows([mk({ at: 0.5, duration: 1 }), mk({ at: 0, duration: 2, loop: true })], 4)
    expect(ws[0]).toMatchObject({ start: 0.5, end: 1.5 })
    expect(ws[1]).toMatchObject({ start: 0, end: 4 })
  })
})
