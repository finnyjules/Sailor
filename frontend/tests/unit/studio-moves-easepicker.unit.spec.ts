// frontend/tests/unit/studio-moves-easepicker.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { easeFromCurveString, easeToCurveString } from '~/components/vue-canvas/motion/moves/easePickerLogic'
import type { MoveEase } from '~/lib/studio/moves/types'

describe('easePickerLogic', () => {
  it('parses a CurveEditor string into a bezier MoveEase', () => {
    expect(easeFromCurveString('[0.87,0,0.13,1]')).toEqual({ kind: 'bezier', cps: [0.87, 0, 0.13, 1] })
  })

  it('round-trips a bezier MoveEase back into the same curve string', () => {
    const ease = easeFromCurveString('[0.87,0,0.13,1]')
    expect(easeToCurveString(ease)).toBe('[0.87,0,0.13,1]')
  })

  it('a named ease has no curve of its own, so it reports the default curve', () => {
    const named: MoveEase = { kind: 'named', name: 'smooth' }
    expect(easeToCurveString(named)).toBe('[0.42,0,0.58,1]')
  })

  it('falls back to the default curve on unparseable or malformed input', () => {
    expect(easeFromCurveString('not json')).toEqual({ kind: 'bezier', cps: [0.42, 0, 0.58, 1] })
    expect(easeFromCurveString('[1,2,3]')).toEqual({ kind: 'bezier', cps: [0.42, 0, 0.58, 1] })
    expect(easeFromCurveString('[1,2,3,"x"]')).toEqual({ kind: 'bezier', cps: [0.42, 0, 0.58, 1] })
  })
})
