import { describe, it, expect } from 'vitest'
import { compileBehaviour } from '~/lib/motionx/behaviour'
import type { Behaviour, BehaviourTarget } from '~/lib/motionx/types'
import { evaluateTrack } from '~/lib/motionx/track'
import type { GradientStop } from '~/lib/color/harmony'

const target: BehaviourTarget = { get: () => undefined, has: () => true }

describe('compileBehaviour', () => {
  it('unknown kind compiles to nothing', () => {
    expect(compileBehaviour({ id: 'x', kind: 'nope', timing: { start: 0, duration: 1 } }, target)).toEqual([])
  })
  it('fade in -> an opacity 0->1 track over the window', () => {
    const b: Behaviour = { id: 'f', kind: 'fade', timing: { start: 0, duration: 2 }, params: { dir: 'in' } }
    const tracks = compileBehaviour(b, target)
    const op = tracks.find(t => t.path === 'opacity')!
    expect(op.type).toBe('number')
    expect(evaluateTrack(op, 0)).toBe(0)
    expect(evaluateTrack(op, 2)).toBe(1)
  })
  it('slide up -> a y track ending at 0 plus a fade', () => {
    const b: Behaviour = { id: 's', kind: 'slide', timing: { start: 0, duration: 1 }, params: { dir: 'up', distance: 40 } }
    const tracks = compileBehaviour(b, target)
    const y = tracks.find(t => t.path === 'y')!
    expect(evaluateTrack(y, 1)).toBe(0)
    expect(tracks.some(t => t.path === 'opacity')).toBe(true)
  })
})

const G: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const gradTarget = { get: (p: string) => (p === 'fill' ? G : undefined), has: () => true }

describe('gradient behaviours', () => {
  it('scroll -> a fill.phase 0->1 number track', () => {
    const t = compileBehaviour({ id: 'sc', kind: 'gradientScroll', timing: { start: 0, duration: 2, loop: true } }, gradTarget)
    const ph = t.find(x => x.path === 'fill.phase')!
    expect(ph.type).toBe('number')
    expect(evaluateTrack(ph, 0)).toBe(0)
    expect(evaluateTrack(ph, 2)).toBe(1)
  })
  it('morph -> a fill gradient track from current to target', () => {
    const To: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const t = compileBehaviour({ id: 'mo', kind: 'gradientMorph', timing: { start: 0, duration: 1 }, params: { to: To, mode: 'travel' } }, gradTarget)
    const fill = t.find(x => x.path === 'fill')!
    expect(fill.type).toBe('gradient')
    expect(fill.mode).toBe('travel')
    expect(fill.keyframes[0]!.value).toEqual(G)
    expect(fill.keyframes[1]!.value).toEqual(To)
  })
})
