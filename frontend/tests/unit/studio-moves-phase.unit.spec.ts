// frontend/tests/unit/studio-moves-phase.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAY } from '~/lib/studio/moves/ease'
import { bandSpans, movePhase, moveWindows } from '~/lib/studio/moves/phase'
import type { Move } from '~/lib/studio/moves/types'

type Timing = Pick<Move, 'phase' | 'duration' | 'ease' | 'play'>

const mk = (o: Partial<Timing>): Timing =>
  ({ phase: 'in', duration: 1, ease: { kind: 'named', name: 'none' }, play: DEFAULT_PLAY, ...o })

describe('studio moves phase', () => {
  it('longest in sets loop phase 0', () => {
    expect(moveWindows([mk({ phase: 'in', duration: 0.6 }), mk({ phase: 'in', duration: 1 })], 4).longestIn).toBeCloseTo(1, 6)
  })
  it('an in move is live only inside its window', () => {
    const a = mk({ phase: 'in', duration: 0.5 })
    expect(movePhase(a, 0.25, 4, 0.5)).toBeCloseTo(0.5, 6)
    expect(movePhase(a, 0.6, 4, 0.5)).toBeNull()
  })
  it('an out move runs at the end', () => {
    const o = mk({ phase: 'out', duration: 0.5 })
    expect(movePhase(o, 3.75, 4, 0)).toBeCloseTo(0.5, 6)
    expect(movePhase(o, 3.0, 4, 0)).toBeNull()
  })
  it('a loop phase 0 sits at the longest in end and wraps', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'repeat', times: 1 } })
    expect(movePhase(l, 1.0, 4, 1.0)).toBeCloseTo(0, 6)
    expect(movePhase(l, 1.5, 4, 1.0)).toBeCloseTo(0.5, 6)
  })
  it('back and forth returns to 0 at the cycle end', () => {
    const l = mk({ phase: 'loop', duration: 1, play: { mode: 'backAndForth', times: 1 } })
    expect(movePhase(l, 1.5, 4, 1.0)).toBeCloseTo(1, 6)
    expect(movePhase(l, 2.0, 4, 1.0)).toBeCloseTo(0, 6)
  })
  it('band spans reflect the longest in and out', () => {
    const s = bandSpans([mk({ phase: 'in', duration: 1 }), mk({ phase: 'out', duration: 0.5 })], 4)
    expect(s.inFrac).toBeCloseTo(0.25, 6)
    expect(s.outFrac).toBeCloseTo(0.125, 6)
    expect(s.loopFrac).toBeCloseTo(0.625, 6)
  })
})
