import { describe, it, expect } from 'vitest'
import { hostedModeEnabled } from '../../app/lib/hostedMode'

describe('hostedModeEnabled', () => {
  it('is true only for boolean true', () => {
    expect(hostedModeEnabled({ hostedMode: true })).toBe(true)
    expect(hostedModeEnabled({ hostedMode: false })).toBe(false)
    expect(hostedModeEnabled({})).toBe(false)
    expect(hostedModeEnabled({ hostedMode: 'true' })).toBe(false) // env leakage is not a yes
  })
})

/**
 * F3 rider (round 3) made hosted's engine origin empty. Step 4, C5: there is
 * no engine origin at all, here or hosted.
 */
describe('no engine origin (C5)', () => {
  it('hostedMode.ts no longer offers one', async () => {
    expect('engineOrigin' in (await import('../../app/lib/hostedMode'))).toBe(false)
  })
})
