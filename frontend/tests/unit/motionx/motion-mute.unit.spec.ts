import { describe, it, expect } from 'vitest'
import { applyMotionxTracks, applyTextBehaviours, applyRevealBehaviours, compileBehaviourForLayer } from '~/lib/motionx/adapter/frame'
import { behaviourBandsForLayer, bandsForLayer } from '~/lib/motionx/bands'
import type { Track, StoredBehaviour } from '~/lib/motionx/types'

const numTrack = (path: string, a: number, b: number, muted?: boolean): Track => ({
  path, type: 'number', keyframes: [{ t: 0, value: a, ease: 'linear' }, { t: 1, value: b, ease: 'linear' }],
  ...(muted ? { muted: true } : {}),
})
const layer = (over: Record<string, unknown> = {}) => ({ id: 'L', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, ...over } as any)

describe('a muted band contributes nothing to any fold', () => {
  it('applyMotionxTracks skips a muted property track (and the identity return holds when all are muted)', () => {
    const live = applyMotionxTracks([layer()], [numTrack('layers.L.opacity', 1, 0)], 0.5)
    expect((live[0] as any).opacity).toBeCloseTo(0.5)
    const muted = applyMotionxTracks([layer()], [numTrack('layers.L.opacity', 1, 0, true)], 0.5)
    expect(muted[0]).toBe(muted[0])       // untouched
    expect((muted[0] as any).opacity).toBe(1)
  })
  it('a muted track among live ones is the only one skipped', () => {
    const out = applyMotionxTracks([layer()], [numTrack('layers.L.opacity', 1, 0, true), numTrack('layers.L.x', 0, 1)], 0.5)
    expect((out[0] as any).opacity).toBe(1)      // muted
    expect((out[0] as any).x).toBeCloseTo(0.5)   // live
  })
  it('applyTextBehaviours skips a muted text behaviour', () => {
    const beh = (muted?: boolean): StoredBehaviour => ({ id: 'b', kind: 'text.wave', layerId: 'L', timing: { start: 0, duration: 1 }, ...(muted ? { muted: true } : {}) })
    const on = applyTextBehaviours([layer({ kind: 'text', text: 'HI' })], [beh()], 0.5)
    expect((on[0] as any).textMotion).toBeTruthy()
    const off = applyTextBehaviours([layer({ kind: 'text', text: 'HI' })], [beh(true)], 0.5)
    expect((off[0] as any).textMotion).toBeUndefined()
  })
  it('applyRevealBehaviours skips a muted reveal track', () => {
    const rt = (muted?: boolean): Track => ({ path: 'layers.L.reveal', type: 'number', behaviourId: 'r', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }], ...(muted ? { muted: true } : {}) })
    const beh: StoredBehaviour[] = [{ id: 'r', kind: 'dither', layerId: 'L', timing: { start: 0, duration: 1 }, params: {} }]
    const on = applyRevealBehaviours([layer()], [rt()], beh, 0.5)
    expect((on[0] as any).motionReveal).toBeTruthy()
    const off = applyRevealBehaviours([layer()], [rt(true)], beh, 0.5)
    expect((off[0] as any).motionReveal).toBeUndefined()
  })
})

describe('mute round-trips through compile and the band builders', () => {
  it('compileBehaviourForLayer stamps muted on every track it produces', () => {
    const on = compileBehaviourForLayer(layer(), { id: 'b', kind: 'fade', timing: { start: 0, duration: 1 }, params: { dir: 'in' } })
    expect(on.every((t) => t.muted === undefined)).toBe(true)
    const off = compileBehaviourForLayer(layer(), { id: 'b', kind: 'fade', timing: { start: 0, duration: 1 }, params: { dir: 'in' }, muted: true })
    expect(off.length).toBeGreaterThan(0)
    expect(off.every((t) => t.muted === true)).toBe(true)
  })
  it('behaviourBandsForLayer and bandsForLayer expose the muted flag', () => {
    const bb = behaviourBandsForLayer('L', [{ id: 'b', kind: 'fade', layerId: 'L', timing: { start: 0, duration: 1 }, muted: true }], [])
    expect(bb[0]!.muted).toBe(true)
    const pb = bandsForLayer('L', [numTrack('layers.L.opacity', 1, 0, true)])
    expect(pb[0]!.muted).toBe(true)
    const pbLive = bandsForLayer('L', [numTrack('layers.L.opacity', 1, 0)])
    expect(pbLive[0]!.muted).toBe(false)
  })
})
