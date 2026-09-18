import { describe, it, expect } from 'vitest'
import {
  setBehaviourTracks, removeBehaviourTracks, bakeBehaviour, upsertBehaviour, removeBehaviour,
} from '~/lib/motionx/behaviourStore'
import { behaviourBandsForLayer, bandsForLayer } from '~/lib/motionx/bands'
import type { Track, StoredBehaviour } from '~/lib/motionx'

const tk = (path: string, behaviourId?: string): Track => ({
  path, type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }],
  ...(behaviourId ? { behaviourId } : {}),
})

describe('setBehaviourTracks', () => {
  it('replaces tracks tagged with the id and stamps the new ones', () => {
    const existing = [tk('layers.a.opacity'), tk('layers.a.x', 'b1'), tk('layers.a.y', 'b1')]
    const next = setBehaviourTracks(existing, 'b1', [tk('layers.a.fill.phase')])
    expect(next.map((t) => t.path)).toEqual(['layers.a.opacity', 'layers.a.fill.phase'])
    expect(next.find((t) => t.path === 'layers.a.fill.phase')!.behaviourId).toBe('b1')
    expect(next.find((t) => t.path === 'layers.a.opacity')!.behaviourId).toBeUndefined()
  })
})

describe('removeBehaviourTracks', () => {
  it('drops only tracks with that id', () => {
    const existing = [tk('layers.a.opacity'), tk('layers.a.x', 'b1')]
    expect(removeBehaviourTracks(existing, 'b1').map((t) => t.path)).toEqual(['layers.a.opacity'])
  })
})

describe('bakeBehaviour', () => {
  it('strips the behaviourId tag so the tracks become plain property bands', () => {
    const existing = [tk('layers.a.x', 'b1'), tk('layers.a.opacity')]
    const baked = bakeBehaviour(existing, 'b1')
    expect(baked.every((t) => t.behaviourId === undefined)).toBe(true)
    expect(baked.map((t) => t.path)).toEqual(['layers.a.x', 'layers.a.opacity'])
  })
})

describe('upsertBehaviour / removeBehaviour', () => {
  const b = (id: string, kind = 'fade'): StoredBehaviour => ({ id, layerId: 'a', kind, timing: { start: 0, duration: 2 } })
  it('appends a new behaviour', () => {
    expect(upsertBehaviour([b('b1')], b('b2')).map((x) => x.id)).toEqual(['b1', 'b2'])
  })
  it('replaces an existing behaviour by id', () => {
    const out = upsertBehaviour([b('b1', 'fade')], b('b1', 'slide'))
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('slide')
  })
  it('removes by id', () => {
    expect(removeBehaviour([b('b1'), b('b2')], 'b1').map((x) => x.id)).toEqual(['b2'])
  })
})

describe('bands: behaviour tagging', () => {
  it('bandsForLayer EXCLUDES tracks that carry a behaviourId', () => {
    const tracks = [tk('layers.a.opacity'), tk('layers.a.x', 'b1')]
    expect(bandsForLayer('a', tracks).map((b) => b.path)).toEqual(['layers.a.opacity'])
  })
  it('behaviourBandsForLayer builds a behaviour band per stored behaviour on that layer', () => {
    const behaviours: StoredBehaviour[] = [
      { id: 'b1', layerId: 'a', kind: 'gradientScroll', timing: { start: 0.5, duration: 2 } },
      { id: 'b2', layerId: 'other', kind: 'fade', timing: { start: 0, duration: 1 } },
    ]
    const bands = behaviourBandsForLayer('a', behaviours)
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ kind: 'behaviour', key: 'b1', behaviourId: 'b1', start: 0.5, end: 2.5 })
  })
})
