import { describe, it, expect } from 'vitest'
import { sculptDecision } from '~/lib/scene3d/sculpt/decision'

describe('sculptDecision', () => {
  it('enters directly when the selection is already a mesh', () => {
    expect(sculptDecision(true, false)).toBe('enter')
    expect(sculptDecision(true, true)).toBe('enter')
  })

  it('asks for confirmation before freezing a non-mesh primitive', () => {
    expect(sculptDecision(false, false)).toBe('confirm')
  })

  it('skips the confirm once suppressed, converting then entering', () => {
    expect(sculptDecision(false, true)).toBe('convert-then-enter')
  })
})
