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
  it('slide up -> ONLY a y track ending at the CURRENT position (relative); no hidden opacity', () => {
    // x/y are normalized 0..1; slide is relative to where the layer sits (target reads 0.4).
    const at: BehaviourTarget = { get: (p) => (p === 'y' ? 0.4 : undefined), has: () => true }
    const b: Behaviour = { id: 's', kind: 'slide', timing: { start: 0, duration: 1 }, params: { dir: 'up', distance: 0.15 } }
    const tracks = compileBehaviour(b, at)
    const y = tracks.find(t => t.path === 'y')!
    expect(evaluateTrack(y, 0)).toBeCloseTo(0.55, 6)   // starts below current (+offset)
    expect(evaluateTrack(y, 1)).toBeCloseTo(0.4, 6)     // ends at current
    expect(tracks).toHaveLength(1)   // one behaviour = one property
  })
  it('every registered behaviour drives exactly ONE property', () => {
    const at: BehaviourTarget = { get: (p) => ({ scale: 1, rotation: 0, y: 0.5, x: 0.5, opacity: 0.8 } as Record<string, number>)[p], has: () => true }
    for (const kind of ['fade', 'slide', 'scale', 'spin', 'pulse', 'sway', 'float', 'gradientScroll']) {
      expect(compileBehaviour({ id: kind, kind, timing: { start: 0, duration: 1 } }, at), kind).toHaveLength(1)
    }
  })
  it('fade in ends at the layer\'s CURRENT opacity, not a hardcoded 1', () => {
    const at: BehaviourTarget = { get: (p) => (p === 'opacity' ? 0.6 : undefined), has: () => true }
    const op = compileBehaviour({ id: 'f', kind: 'fade', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, at)[0]!
    expect(evaluateTrack(op, 0)).toBe(0)
    expect(evaluateTrack(op, 1)).toBe(0.6)
  })
})

describe('whole-layer transform behaviours (Slice 5)', () => {
  const at: BehaviourTarget = { get: (p) => ({ scale: 1, rotation: 0, y: 0.5 } as Record<string, number>)[p], has: () => true }
  it('scale in -> scale 0->current only (no opacity side-effect)', () => {
    const t = compileBehaviour({ id: 'a', kind: 'scale', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, at)
    expect(t).toHaveLength(1)
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

describe('behaviour easing override (params.ease)', () => {
  const target = { get: () => 1 }
  const beh = (params: Record<string, unknown>) =>
    ({ id: 'b', kind: 'fade', params, timing: { start: 0, duration: 1 } }) as never
  it('without params.ease the compiled track is unchanged', async () => {
    const { compileBehaviour } = await import('~/lib/motionx')
    expect(compileBehaviour(beh({ dir: 'in' }), target as never)[0]!.keyframes.map((k) => k.ease)).toEqual(['easeInOut', 'linear'])
  })
  it('a named or bézier params.ease replaces every segment ease (the unused last point is left alone)', async () => {
    const { compileBehaviour } = await import('~/lib/motionx')
    const bez = [0.34, 1.56, 0.64, 1]
    expect(compileBehaviour(beh({ dir: 'in', ease: bez }), target as never)[0]!.keyframes.map((k) => k.ease)).toEqual([bez, 'linear'])
    const pulse = compileBehaviour({ id: 'p', kind: 'pulse', params: { ease: 'easeOut' }, timing: { start: 0, duration: 1 } } as never, target as never)[0]!
    expect(pulse.keyframes.map((k) => k.ease)).toEqual(['easeOut', 'easeOut', 'easeInOut'])
  })
  it('ignores a malformed params.ease', async () => {
    const { compileBehaviour } = await import('~/lib/motionx')
    expect(compileBehaviour(beh({ dir: 'in', ease: [1, 2] }), target as never)[0]!.keyframes[0]!.ease).toBe('easeInOut')
  })
  it('a steps params.ease replaces every segment ease', async () => {
    const { compileBehaviour } = await import('~/lib/motionx')
    const steps = { type: 'steps', count: 5 }
    expect(compileBehaviour(beh({ dir: 'in', ease: steps }), target as never)[0]!.keyframes.map((k) => k.ease)).toEqual([steps, 'linear'])
  })
  it('an invalid steps object (non-finite count) falls back to the kind\'s default', async () => {
    const { compileBehaviour } = await import('~/lib/motionx')
    expect(compileBehaviour(beh({ dir: 'in', ease: { type: 'steps', count: 'nope' } }), target as never)[0]!.keyframes[0]!.ease).toBe('easeInOut')
    expect(compileBehaviour(beh({ dir: 'in', ease: { type: 'steps' } }), target as never)[0]!.keyframes[0]!.ease).toBe('easeInOut')
  })
})

describe('timing.loop is the one loop switch for every kind', () => {
  const target = { get: () => 1 }
  const c = async (kind: string, loop?: boolean) => {
    const { compileBehaviour } = await import('~/lib/motionx')
    return compileBehaviour({ id: 'b', kind, params: {}, timing: { start: 0, duration: 1, ...(loop === undefined ? {} : { loop }) } } as never, target as never)[0]!
  }
  it('unset keeps each kind\'s default (pulse loops, fade does not)', async () => {
    expect((await c('pulse')).loop).toBe(true)
    expect((await c('fade')).loop ?? false).toBe(false)
  })
  it('true / false override it either way', async () => {
    expect((await c('fade', true)).loop).toBe(true)
    expect((await c('pulse', false)).loop).toBe(false)
  })
})

describe('scale — start and finish size as a percentage of the layer', () => {
  const at = { get: (p: string) => ({ scale: 2 } as Record<string, number>)[p], has: () => true } as never
  const compile = async (params: Record<string, unknown>) => {
    const { compileBehaviour } = await import('~/lib/motionx')
    return compileBehaviour({ id: 's', kind: 'scale', timing: { start: 0, duration: 1 }, params } as never, at)[0]!.keyframes.map((k) => k.value)
  }
  it('defaults are unchanged: in = 0% → 100%, out = 100% → 0% (of the layer\'s own size)', async () => {
    expect(await compile({ dir: 'in' })).toEqual([0, 2])
    expect(await compile({ dir: 'out' })).toEqual([2, 0])
    expect(await compile({})).toEqual([0, 2])
  })
  it('from / to override either end; 100% is the layer\'s current size', async () => {
    expect(await compile({ dir: 'in', from: 50, to: 120 })).toEqual([1, 2.4])
    expect(await compile({ dir: 'in', from: 80 })).toEqual([1.6, 2])
    expect(await compile({ dir: 'out', to: 25 })).toEqual([2, 0.5])
  })
  it('garbage falls back to the direction\'s default; negatives clamp to 0', async () => {
    expect(await compile({ dir: 'in', from: NaN, to: 'big' })).toEqual([0, 2])
    expect(await compile({ dir: 'in', from: -40, to: 100 })).toEqual([0, 2])
  })
})

// ── Copies (Cloner dials as motion, Task 7) ──
//
// Mode detection reads `cloner.mode` (a STRING the frame adapter now answers) — NOT whether
// `cloner.count` happens to be a number, since `count` is a field of every cloner regardless
// of mode. Each fake target below stands in for a radial and a linear cloner respectively.
const radialCloner: BehaviourTarget = {
  get: (p) => ({
    'cloner.mode': 'radial', 'cloner.count': 6, 'cloner.radius': 0.3,
    'cloner.startAngle': 0, 'cloner.stepRotation': 0, 'cloner.stepOpacity': 1,
  } as Record<string, string | number>)[p],
  has: () => true,
}
const linearCloner: BehaviourTarget = {
  get: (p) => ({
    'cloner.mode': 'linear', 'cloner.countX': 4, 'cloner.spacingX': 0.2, 'cloner.spacingY': 0.1,
    'cloner.stepRotation': 0, 'cloner.stepOpacity': 1,
  } as Record<string, string | number>)[p],
  has: () => true,
}

describe('copies.build — count in/out, radial vs linear path', () => {
  it('radial animates cloner.count 1 -> cur (in) / cur -> 1 (out), ease linear', () => {
    const inT = compileBehaviour({ id: '1', kind: 'copies.build', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, radialCloner)[0]!
    expect(inT.path).toBe('cloner.count')
    expect(evaluateTrack(inT, 0)).toBe(1)
    expect(evaluateTrack(inT, 1)).toBe(6)
    expect(inT.keyframes[0]!.ease).toBe('linear')
    const outT = compileBehaviour({ id: '2', kind: 'copies.build', timing: { start: 0, duration: 1 }, params: { dir: 'out' } }, radialCloner)[0]!
    expect(evaluateTrack(outT, 0)).toBe(6)
    expect(evaluateTrack(outT, 1)).toBe(1)
  })
  it('linear animates cloner.countX instead', () => {
    const inT = compileBehaviour({ id: '1', kind: 'copies.build', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, linearCloner)[0]!
    expect(inT.path).toBe('cloner.countX')
    expect(evaluateTrack(inT, 0)).toBe(1)
    expect(evaluateTrack(inT, 1)).toBe(4)
  })
  it('defaults to dir "in" with no params', () => {
    const t = compileBehaviour({ id: '1', kind: 'copies.build', timing: { start: 0, duration: 1 } }, radialCloner)[0]!
    expect(evaluateTrack(t, 0)).toBe(1)
    expect(evaluateTrack(t, 1)).toBe(6)
  })
})

describe('copies.spread — radius (radial) or spacingX/Y (linear), out/in', () => {
  it('radial animates cloner.radius 0 -> cur (out) / cur -> 0 (in)', () => {
    const outT = compileBehaviour({ id: '1', kind: 'copies.spread', timing: { start: 0, duration: 1 }, params: { dir: 'out' } }, radialCloner)[0]!
    expect(outT.path).toBe('cloner.radius')
    expect(evaluateTrack(outT, 0)).toBe(0)
    expect(evaluateTrack(outT, 1)).toBeCloseTo(0.3, 6)
    const inT = compileBehaviour({ id: '2', kind: 'copies.spread', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, radialCloner)[0]!
    expect(evaluateTrack(inT, 0)).toBeCloseTo(0.3, 6)
    expect(evaluateTrack(inT, 1)).toBe(0)
  })
  it('linear defaults to axis x (spacingX); axis y drives spacingY', () => {
    const x = compileBehaviour({ id: '1', kind: 'copies.spread', timing: { start: 0, duration: 1 }, params: { dir: 'out' } }, linearCloner)[0]!
    expect(x.path).toBe('cloner.spacingX')
    expect(evaluateTrack(x, 1)).toBeCloseTo(0.2, 6)
    const y = compileBehaviour({ id: '2', kind: 'copies.spread', timing: { start: 0, duration: 1 }, params: { dir: 'out', axis: 'y' } }, linearCloner)[0]!
    expect(y.path).toBe('cloner.spacingY')
    expect(evaluateTrack(y, 1)).toBeCloseTo(0.1, 6)
  })
})

describe('copies.spin — startAngle ramps a full turn, loops by default, ease linear', () => {
  it('cur -> cur + 360 over the window', () => {
    const t = compileBehaviour({ id: '1', kind: 'copies.spin', timing: { start: 0, duration: 2 } }, radialCloner)[0]!
    expect(t.path).toBe('cloner.startAngle')
    expect(t.loop).toBe(true)
    expect(evaluateTrack(t, 0)).toBe(0)
    expect(evaluateTrack(t, 1)).toBeCloseTo(180, 6)
    expect(t.keyframes[0]!.ease).toBe('linear')
  })
  it('timing.loop: false overrides the default (the shared loop switch)', () => {
    const t = compileBehaviour({ id: '1', kind: 'copies.spin', timing: { start: 0, duration: 2, loop: false } }, radialCloner)[0]!
    expect(t.loop).toBe(false)
  })
})

describe('copies.fan — stepRotation in/out; fallback full angle when current is 0', () => {
  it('radial fallback is 360 / count (60deg for a 6-copy ring)', () => {
    const inT = compileBehaviour({ id: '1', kind: 'copies.fan', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, radialCloner)[0]!
    expect(inT.path).toBe('cloner.stepRotation')
    expect(evaluateTrack(inT, 0)).toBe(0)
    expect(evaluateTrack(inT, 1)).toBeCloseTo(60, 6)
    const outT = compileBehaviour({ id: '2', kind: 'copies.fan', timing: { start: 0, duration: 1 }, params: { dir: 'out' } }, radialCloner)[0]!
    expect(evaluateTrack(outT, 0)).toBeCloseTo(60, 6)
    expect(evaluateTrack(outT, 1)).toBe(0)
  })
  it('linear fallback is a flat 15deg', () => {
    const inT = compileBehaviour({ id: '1', kind: 'copies.fan', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, linearCloner)[0]!
    expect(evaluateTrack(inT, 1)).toBeCloseTo(15, 6)
  })
  it('a nonzero current stepRotation is used as-is (no fallback)', () => {
    const at: BehaviourTarget = { get: (p) => ({ 'cloner.mode': 'radial', 'cloner.stepRotation': 40, 'cloner.count': 6 } as Record<string, string | number>)[p], has: () => true }
    const t = compileBehaviour({ id: '1', kind: 'copies.fan', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, at)[0]!
    expect(evaluateTrack(t, 1)).toBeCloseTo(40, 6)
  })
})

describe('copies.fade — stepOpacity 0->cur (in) / cur->0 (out)', () => {
  it('in / out', () => {
    const inT = compileBehaviour({ id: '1', kind: 'copies.fade', timing: { start: 0, duration: 1 }, params: { dir: 'in' } }, radialCloner)[0]!
    expect(inT.path).toBe('cloner.stepOpacity')
    expect(evaluateTrack(inT, 0)).toBe(0)
    expect(evaluateTrack(inT, 1)).toBeCloseTo(1, 6)
    const outT = compileBehaviour({ id: '2', kind: 'copies.fade', timing: { start: 0, duration: 1 }, params: { dir: 'out' } }, radialCloner)[0]!
    expect(evaluateTrack(outT, 0)).toBeCloseTo(1, 6)
    expect(evaluateTrack(outT, 1)).toBe(0)
  })
})
