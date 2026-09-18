import { describe, it, expect } from 'vitest'
import { compileBehaviour, evaluateTracks } from '~/lib/motionx'
import type { BehaviourTarget } from '~/lib/motionx'
import type { GradientStop } from '~/lib/color/harmony'

const G: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const target: BehaviourTarget = { get: (p) => (p === 'fill' ? G : undefined), has: () => true }

describe('motionx pipeline', () => {
  it('fade in compiles and evaluates end to end', () => {
    const tracks = compileBehaviour({ id: 'f', kind: 'fade', timing: { start: 0, duration: 2 }, params: { dir: 'in' } }, target)
    expect(evaluateTracks(tracks, 0).get('opacity')).toBe(0)
    expect(evaluateTracks(tracks, 2).get('opacity')).toBe(1)
    const mid = evaluateTracks(tracks, 1).get('opacity') as number
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1)
  })
  it('gradient morph evaluates to a stop array mid-transition', () => {
    const To: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const tracks = compileBehaviour({ id: 'm', kind: 'gradientMorph', timing: { start: 0, duration: 1 }, params: { to: To } }, target)
    const v = evaluateTracks(tracks, 0.5).get('fill')
    expect(Array.isArray(v)).toBe(true)
  })
})
