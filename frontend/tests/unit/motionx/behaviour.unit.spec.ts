import { describe, it, expect } from 'vitest'
import { compileBehaviour } from '~/lib/motionx/behaviour'
import type { Behaviour, BehaviourTarget } from '~/lib/motionx/types'
import { evaluateTrack } from '~/lib/motionx/track'

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
