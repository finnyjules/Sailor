// frontend/tests/unit/shaderstudio-take-lock.unit.spec.ts
// The Shader studio's layer lock while an effect-take set is open (stage 5 Task 9).
import { describe, it, expect } from 'vitest'
import { takeLayerLocked, takeStackLocked } from '~/lib/shaderstudio/takeLock'

describe('Shader studio take lock', () => {
  it('locks the layer the open set previews on, and only that one', () => {
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L1', takeLayerId: 'L1' })).toBe(true)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L2', takeLayerId: 'L1' })).toBe(false)
  })
  it('is derived from the session: a closed set never leaves it locked, whatever id is left behind', () => {
    expect(takeLayerLocked({ setOpen: false, activeLayerId: 'L1', takeLayerId: 'L1' })).toBe(false)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L1', takeLayerId: null })).toBe(false)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: undefined, takeLayerId: null })).toBe(false)
  })
  it('the stack holds still while any set is open', () => {
    expect(takeStackLocked({ setOpen: true })).toBe(true)
    expect(takeStackLocked({ setOpen: false })).toBe(false)
  })
})
