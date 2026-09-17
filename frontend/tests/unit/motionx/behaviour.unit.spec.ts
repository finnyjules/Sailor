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
  it('slide up -> a y track ending at the CURRENT position (relative) plus a fade', () => {
    // x/y are normalized 0..1; slide is relative to where the layer sits (target reads 0.4).
    const at: BehaviourTarget = { get: (p) => (p === 'y' ? 0.4 : undefined), has: () => true }
    const b: Behaviour = { id: 's', kind: 'slide', timing: { start: 0, duration: 1 }, params: { dir: 'up', distance: 0.15 } }
    const tracks = compileBehaviour(b, at)
    const y = tracks.find(t => t.path === 'y')!
    expect(evaluateTrack(y, 0)).toBeCloseTo(0.55, 6)   // starts below current (+offset)
    expect(evaluateTrack(y, 1)).toBeCloseTo(0.4, 6)     // ends at current
    expect(tracks.some(t => t.path === 'opacity')).toBe(true)
  })
})

describe('whole-layer transform behaviours (Slice 5)', () => {
  const at: BehaviourTarget = { get: (p) => ({ scale: 1, rotation: 0, y: 0.5 } as Record<string, number>)[p], has: () => true }
  it('scale in -> scale 0->current + opacity 0->1', () => {
    const t = compileBehaviour({ id: 'a', kind: 'scale', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, at)
    const s = t.find(x => x.path === 'scale')!
    expect(evaluateTrack(s, 0)).toBe(0)
    expect(evaluateTrack(s, 1)).toBe(1)
  })
  it('spin -> a looping rotation ramp of 360deg', () => {
    const t = compileBehaviour({ id: 'b', kind: 'spin', timing: { start: 0, duration: 2, loop: true } }, at)
    const r = t.find(x => x.path === 'rotation')!
    expect(r.loop).toBe(true)
    expect(evaluateTrack(r, 0)).toBe(0)
    expect(evaluateTrack(r, 2)).toBeCloseTo(0, 6)   // 360 wraps back to 0 at the loop seam
    expect(evaluateTrack(r, 1)).toBeCloseTo(180, 6)
  })
  it('pulse -> a looping scale that returns to current', () => {
    const t = compileBehaviour({ id: 'c', kind: 'pulse', timing: { start: 0, duration: 2 }, params: { amount: 0.2 } }, at)
    const s = t.find(x => x.path === 'scale')!
    expect(s.loop).toBe(true)
    expect(evaluateTrack(s, 0)).toBe(1)
    expect(evaluateTrack(s, 1)).toBeCloseTo(1.2, 6)  // peak at mid
  })
  it('sway -> a looping rotation oscillation around current', () => {
    const t = compileBehaviour({ id: 'd', kind: 'sway', timing: { start: 0, duration: 4 }, params: { degrees: 10 } }, at)
    const r = t.find(x => x.path === 'rotation')!
    expect(r.loop).toBe(true)
    expect(evaluateTrack(r, 1)).toBeCloseTo(10, 6)   // +deg at first quarter
    expect(evaluateTrack(r, 3)).toBeCloseTo(-10, 6)  // -deg at third quarter
  })
  it('float -> a looping y drift returning to current', () => {
    const t = compileBehaviour({ id: 'e', kind: 'float', timing: { start: 0, duration: 2 }, params: { amount: 0.04 } }, at)
    const y = t.find(x => x.path === 'y')!
    expect(y.loop).toBe(true)
    expect(evaluateTrack(y, 0)).toBe(0.5)
    expect(evaluateTrack(y, 1)).toBeCloseTo(0.46, 6)  // drifts up by amount at mid
  })
})

const G: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const gradTarget = { get: (p: string) => (p === 'fill' ? G : undefined), has: () => true }

describe('gradient behaviours', () => {
  it('scroll -> a looping fill.phase 0->1 track that wraps', () => {
    const t = compileBehaviour({ id: 'sc', kind: 'gradientScroll', timing: { start: 0, duration: 2, loop: true } }, gradTarget)
    const ph = t.find(x => x.path === 'fill.phase')!
    expect(ph.type).toBe('number'); expect(ph.loop).toBe(true)
    expect(evaluateTrack(ph, 0)).toBe(0)
    expect(evaluateTrack(ph, 1)).toBeCloseTo(0.5, 6)
    expect(evaluateTrack(ph, 4)).toBeCloseTo(0, 6)   // wraps (2 full spans) — was falsely 1 before the fix
    expect(evaluateTrack(ph, 3)).toBeCloseTo(0.5, 6) // wraps to t=1
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
