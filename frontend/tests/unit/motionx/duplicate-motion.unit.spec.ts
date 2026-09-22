import { describe, it, expect } from 'vitest'
import { motionForCopies } from '~/lib/motionx/adapter/duplicateMotion'

const ids = () => { let n = 0; return () => `b${++n}` }
const band = (id: string, prop: string, behaviourId?: string) => ({
  path: `layers.${id}.${prop}`, type: 'number' as const,
  keyframes: [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1, value: 1 }], ...(behaviourId ? { behaviourId } : {}),
})

describe('motionForCopies', () => {
  const motion = {
    motionx: [band('a', 'opacity', 'bh1'), band('a', 'reveal', 'bh2'), band('z', 'x')],
    behaviours: [
      { id: 'bh1', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 }, params: { dir: 'in' } },
      { id: 'bh2', kind: 'settle', layerId: 'a', timing: { start: 0.5, duration: 1 }, params: { effect: 'slice' } },
      { id: 'bh9', kind: 'fade', layerId: 'z', timing: { start: 0, duration: 1 } },
    ],
    tracks: [{ target: 'layers.a.effects.fx1.amount', keyframes: [{ t: 0, v: 1 }] }, { target: 'layers.z.effects.fx1.amount', keyframes: [] }],
  }
  const idMap = new Map([['a', 'a2']])

  it('re-targets every band, behaviour and dial track of a mapped layer, and nothing else', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    expect(r.motionx.map((t) => t.path)).toEqual(['layers.a2.opacity', 'layers.a2.reveal'])
    expect(r.behaviours.map((b) => b.layerId)).toEqual(['a2', 'a2'])
    expect(r.tracks.map((t) => t.target)).toEqual(['layers.a2.effects.fx1.amount'])
  })
  it('gives behaviours fresh ids and keeps each compiled track pointing at its copy', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    expect(r.behaviours.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(r.motionx.map((t) => t.behaviourId)).toEqual(['b1', 'b2'])
    expect(r.behaviours[1]).toMatchObject({ kind: 'settle', timing: { start: 0.5, duration: 1 }, params: { effect: 'slice' } })
  })
  it('deep-copies: mutating the result leaves the input alone', () => {
    const r = motionForCopies(motion as any, idMap, ids())
    r.motionx[0]!.keyframes[0]!.value = 99
    ;(r.behaviours[0]!.params as any).dir = 'out'
    expect(motion.motionx[0]!.keyframes[0]!.value).toBe(0)
    expect(motion.behaviours[0]!.params!.dir).toBe('in')
  })
  it('an empty motion doc or an unmapped selection gives empty lists', () => {
    expect(motionForCopies({}, idMap, ids())).toEqual({ motionx: [], behaviours: [], tracks: [] })
    expect(motionForCopies(motion as any, new Map([['q', 'q2']]), ids())).toEqual({ motionx: [], behaviours: [], tracks: [] })
  })
})
