// frontend/tests/unit/shaderstudio-clock.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { effectWantsClock, stackWantsClock } from '~/lib/shaderstudio/clock'
import type { EffectDef } from '~/lib/shaderfx/types'
import catalogJson from '../../../shader_effects/manifest.json'

const CATALOG = (catalogJson as unknown as { effects: EffectDef[] }).effects
const def = (id: string): EffectDef => {
  const d = CATALOG.find(e => e.id === id)
  if (!d) throw new Error(`no such effect: ${id}`)
  return d
}

/**
 * The studio preview only ran a clock for motion tracks or a moving source, so an
 * effect that drives itself off `u_time` rendered one frame and looked broken —
 * its Speed / Motion controls did nothing. These pin the widened condition.
 */
describe('effectWantsClock', () => {
  it('culture: Still wants no clock, Drift does', () => {
    expect(effectWantsClock(def('culture'), {})).toBe(false)              // u_motion default 0
    expect(effectWantsClock(def('culture'), { u_motion: 0 })).toBe(false)
    expect(effectWantsClock(def('culture'), { u_motion: 1 })).toBe(true)  // Drift
    expect(effectWantsClock(def('culture'), { u_motion: 2 })).toBe(true)  // Grow
    expect(effectWantsClock(def('culture'), { u_motion: 3 })).toBe(true)  // Cycle
  })

  it('culture: a moving mode with the speed dial at zero is still', () => {
    expect(effectWantsClock(def('culture'), { u_motion: 1, u_speed: 0 })).toBe(false)
  })

  it('mist: speed 0 wants no clock, speed 0.5 does', () => {
    expect(effectWantsClock(def('mist'), { u_speed: 0 })).toBe(false)
    expect(effectWantsClock(def('mist'), { u_speed: 0.5 })).toBe(true)
    expect(effectWantsClock(def('mist'), {})).toBe(true)                  // default 1.0
  })

  it('a STATIC effect (animated:false) with no time dial never asks for a clock', () => {
    expect(effectWantsClock(def('oddgrid'), {})).toBe(false)
    expect(effectWantsClock(def('halftone'), {})).toBe(false)
    expect(effectWantsClock(null, {})).toBe(false)
  })

  it('an ANIMATED effect with no rate dial animates unconditionally off u_time', () => {
    // slice_shift drives itself off u_time directly (no u_speed/u_shimmer dial to
    // gate or scale it), so the studio must still run a clock or it renders one
    // frozen frame — the exact bug where Speed/Step "did nothing" in the studio.
    expect(effectWantsClock(def('slice_shift'), {})).toBe(true)
  })

  it('reads u_shimmer too — the only other dial any frag multiplies u_time by', () => {
    expect(effectWantsClock(def('holographic'), {})).toBe(true)           // default 0.25
    expect(effectWantsClock(def('holographic'), { u_shimmer: 0 })).toBe(false)
  })

  it('an out-of-range or junk override falls back to the declared default', () => {
    // resolveValues clamps/repairs before the dial is read, so a bad stored value
    // can neither fake motion nor hide it.
    expect(effectWantsClock(def('mist'), { u_speed: '2' as unknown as number })).toBe(true)
    expect(effectWantsClock(def('culture'), { u_motion: 9 })).toBe(false) // not an option → default 0
  })
})

describe('stackWantsClock', () => {
  const resolve = (id: string) => CATALOG.find(e => e.id === id) ?? null
  const layer = (id: string, params: Record<string, number> = {}, enabled = true) =>
    ({ id, params, enabled }) as any

  it('is true when ANY enabled layer asks for a clock', () => {
    expect(stackWantsClock([layer('halftone'), layer('culture', { u_motion: 1 })], resolve)).toBe(true)
  })

  it('ignores disabled layers and empty slots', () => {
    expect(stackWantsClock([layer('culture', { u_motion: 1 }, false)], resolve)).toBe(false)
    expect(stackWantsClock([layer('')], resolve)).toBe(false)
    expect(stackWantsClock([], resolve)).toBe(false)
  })
})
