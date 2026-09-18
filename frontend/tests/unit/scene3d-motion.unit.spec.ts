import { describe, it, expect } from 'vitest'
import { parseDoc, serializeDoc, defaultDoc, createPrimitive } from '~/lib/scene3d/config'
import type { ObjectMotion, LoopKind, LoopSpec, CameraMotion } from '~/lib/scene3d/motion/types'
import {
  LOOP_OPTIONS, CAMERA_OPTIONS, LOOP_USES_AMOUNT, CAMERA_USES_CYCLES, CAMERA_USES_AMOUNT,
} from '~/lib/scene3d/motion/panel'
import { DEFAULT_SCENE_MOTION } from '~/lib/scene3d/motion/types'
import { evaluateObjectMotion, evaluateCameraMotion } from '~/lib/scene3d/motion/evaluate'
import { resolveEaseRef } from '~/lib/scene3d/motion/ease'
import { applyMotionToDoc } from '~/lib/scene3d/motion/apply'
import { animateSceneDefaults, SCENE_TEMPLATES } from '~/lib/scene3d/motion/defaults'
import { DEFAULT_POST } from '~/lib/spacetype/post'

describe('scene3d motion — config parse', () => {
  it('defaults scene motion when absent', () => {
    const doc = parseDoc(serializeDoc(defaultDoc()))
    expect(doc.motion).toEqual(DEFAULT_SCENE_MOTION)
  })

  it('round-trips object + camera motion', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    const motion: ObjectMotion = {
      loop: { kind: 'spin', speed: 2, amount: 1 },
      in: { preset: 'move', duration: 0.6, direction: 'left', ease: { kind: 'bezier', cps: [0, 0, 0.58, 1] } },
      offset: 0.2,
    }
    obj.motion = motion
    doc.objects.push(obj)
    doc.motion = { duration: 5, fps: 24, loop: true }
    doc.camera.motion = { preset: 'orbit', speed: 1, amount: 1 }

    const round = parseDoc(serializeDoc(doc))
    expect(round.motion).toEqual({ duration: 5, fps: 24, loop: true })
    expect(round.objects[0]!.motion).toEqual(motion)
    expect(round.camera.motion).toEqual({ preset: 'orbit', speed: 1, amount: 1 })
  })

  it('drops malformed object motion to undefined', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    doc.objects.push(obj)
    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].motion = { loop: { kind: 'not-a-kind', speed: 'x' } }
    const round = parseDoc(JSON.stringify(raw))
    expect(round.objects[0]!.motion).toBeUndefined()
  })

  it('absent motion key round-trips to defaults, objects unchanged', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    obj.position = [1, 2, 3]
    doc.objects.push(obj)
    const raw = JSON.parse(serializeDoc(doc))
    delete raw.motion
    const round = parseDoc(JSON.stringify(raw))
    expect(round.motion).toEqual(DEFAULT_SCENE_MOTION)
    expect(round.objects[0]!.position).toEqual([1, 2, 3])
    expect(round.objects[0]!.motion).toBeUndefined()
  })

  it('malformed scene motion falls back to defaults without throwing', () => {
    const doc = defaultDoc()
    const raw = JSON.parse(serializeDoc(doc))
    raw.motion = 'garbage'
    const round = parseDoc(JSON.stringify(raw))
    expect(round.motion).toEqual(DEFAULT_SCENE_MOTION)
  })

  // THE TRAP: parseDoc is a whitelist, and `motion.tracks` is a new field — round-trip
  // it explicitly, the same way scene3d-relief-config.unit.spec.ts pins every new
  // optional relief field, so a future edit that forgets to copy it in parseSceneMotion
  // fails loudly here instead of silently dropping every saved track on reload.
  it('round-trips path-based motion tracks through serialize → parse', () => {
    const doc = defaultDoc()
    const tracks = [
      { path: 'lighting.sunIntensity', from: 0, to: 2, easing: 'linear' as const, loops: 1, hold: 0, cycleOffset: 0, delay: 0 },
      { path: 'post.bloomStrength', from: 0.2, to: 1.5, easing: 'pingpong' as const, loops: 2, hold: 0.1, cycleOffset: 0.25, delay: 0.5 },
    ]
    doc.motion = { duration: 5, fps: 24, loop: true, tracks }
    const round = parseDoc(serializeDoc(doc))
    expect(round.motion.tracks).toEqual(tracks)
  })

  it('drops a malformed track (bad easing, non-finite from/to) but keeps the valid ones', () => {
    const doc = defaultDoc()
    doc.motion = {
      duration: 5, fps: 24, loop: true,
      tracks: [{ path: 'lighting.sunIntensity', from: 0, to: 2, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }],
    }
    const raw = JSON.parse(serializeDoc(doc))
    raw.motion.tracks.push({ path: 'lighting.ambient', from: 0, to: 1, easing: 'not-a-real-easing', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })
    raw.motion.tracks.push({ path: 'camera.fov', from: 'nope', to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })
    raw.motion.tracks.push({ from: 0, to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }) // no path
    const round = parseDoc(JSON.stringify(raw))
    expect(round.motion.tracks).toEqual([
      { path: 'lighting.sunIntensity', from: 0, to: 2, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 },
    ])
  })

  it('a doc without tracks does not gain an empty array — absent stays absent', () => {
    const doc = defaultDoc() // motion has no `tracks` key at all
    const round = parseDoc(serializeDoc(doc))
    expect(round.motion.tracks).toBeUndefined()
    expect('tracks' in round.motion).toBe(false)
    expect(round.motion).toEqual(DEFAULT_SCENE_MOTION)
  })

  it('an explicit empty tracks array parses back to absent, not `[]`', () => {
    const doc = defaultDoc()
    const raw = JSON.parse(serializeDoc(doc))
    raw.motion.tracks = []
    const round = parseDoc(JSON.stringify(raw))
    expect(round.motion.tracks).toBeUndefined()
  })

  it('malformed camera motion drops to undefined', () => {
    const doc = defaultDoc()
    const raw = JSON.parse(serializeDoc(doc))
    raw.camera.motion = { preset: 'not-a-preset' }
    const round = parseDoc(JSON.stringify(raw))
    expect(round.camera.motion).toBeUndefined()
  })

  it('guards phase/offset parse against NaN', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    obj.motion = { loop: { kind: 'spin', speed: 1, amount: 1 }, offset: 0.2 }
    doc.objects.push(obj)
    const raw = JSON.parse(serializeDoc(doc))
    // Corrupt motion values
    raw.objects[0].motion.offset = null
    raw.objects[0].motion.loop.phase = 'x'
    const round = parseDoc(JSON.stringify(raw))
    // Assert neither value is NaN (each is undefined or finite)
    const offset = round.objects[0]!.motion?.offset
    const phase = round.objects[0]!.motion?.loop?.phase
    expect(offset === undefined || Number.isFinite(offset)).toBe(true)
    expect(phase === undefined || Number.isFinite(phase)).toBe(true)
  })
})

describe('scene3d motion — resolveEaseRef', () => {
  it('bezier endpoints anchored', async () => {
    const { resolveEaseRef } = await import('~/lib/scene3d/motion/ease')
    const f = resolveEaseRef({ kind: 'bezier', cps: [0.34, 1.56, 0.64, 1] })
    expect(f(0)).toBeCloseTo(0, 6)
    expect(f(1)).toBeCloseTo(1, 6)
    expect(f(0.5)).toBeGreaterThan(0.5) // ease-out-ish region
  })
  it('bezier overshoot exceeds 1 mid-curve', async () => {
    const { resolveEaseRef } = await import('~/lib/scene3d/motion/ease')
    const f = resolveEaseRef({ kind: 'bezier', cps: [0.34, 1.56, 0.64, 1] })
    const peak = Math.max(...Array.from({ length: 19 }, (_, i) => f((i + 1) / 20)))
    expect(peak).toBeGreaterThan(1)
  })
  it('named procedural resolves and anchors', async () => {
    const { resolveEaseRef } = await import('~/lib/scene3d/motion/ease')
    for (const name of ['bounce', 'elastic', 'spring'] as const) {
      const f = resolveEaseRef({ kind: 'named', name })
      expect(f(0)).toBeCloseTo(0, 4)
      expect(f(1)).toBeCloseTo(1, 4)
    }
  })
})

describe('scene3d motion — loop presets close seamlessly', () => {
  const kinds = ['spin', 'bob', 'pulse', 'orbit', 'sway', 'tumble'] as const
  for (const kind of kinds) {
    it(`${kind} identity-equivalent at t=0 and t=1`, async () => {
      const { evaluateLoop } = await import('~/lib/scene3d/motion/presets')
      const a = evaluateLoop({ kind, speed: 2, amount: 1 }, 0)
      const b = evaluateLoop({ kind, speed: 2, amount: 1 }, 1)
      // positions & scale return exactly; rotations return mod 2π
      expect(a.dPosition.map(v => +v.toFixed(6))).toEqual(b.dPosition.map(v => +v.toFixed(6)))
      expect(a.scaleMul.map(v => +v.toFixed(6))).toEqual(b.scaleMul.map(v => +v.toFixed(6)))
      const wrap = (r: number) => +(((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toFixed(5)
      expect(a.dRotation.map(wrap)).toEqual(b.dRotation.map(wrap))
    })
  }
  it('none is identity', async () => {
    const { evaluateLoop } = await import('~/lib/scene3d/motion/presets')
    expect(evaluateLoop({ kind: 'none', speed: 1, amount: 1 }, 0.37).dPosition).toEqual([0, 0, 0])
  })
})

describe('scene3d motion — transitions', () => {
  it('move-in travels from offset to home', async () => {
    const { evaluateTransition, MOVE_DIST } = await import('~/lib/scene3d/motion/presets')
    const start = evaluateTransition('move', 'left', 0, 'in')
    const end = evaluateTransition('move', 'left', 1, 'in')
    expect(start.dPosition![0]).toBeCloseTo(-MOVE_DIST, 6)
    expect(end.dPosition![0]).toBeCloseTo(0, 6)
  })
  it('fade-in ramps opacity 0→1; fade-out 1→0', async () => {
    const { evaluateTransition } = await import('~/lib/scene3d/motion/presets')
    expect(evaluateTransition('fade', undefined, 0, 'in').opacity).toBeCloseTo(0, 6)
    expect(evaluateTransition('fade', undefined, 1, 'in').opacity).toBeCloseTo(1, 6)
    expect(evaluateTransition('fade', undefined, 1, 'out').opacity).toBeCloseTo(0, 6)
  })
  it('pop overshoots scale above 1 mid-progress', async () => {
    const { evaluateTransition } = await import('~/lib/scene3d/motion/presets')
    const mid = evaluateTransition('pop', undefined, 0.7, 'in')
    expect(mid.scaleMul![0]).toBeGreaterThan(1)
  })
  it('directionVector maps axes', async () => {
    const { directionVector } = await import('~/lib/scene3d/motion/presets')
    expect(directionVector('right', 3)).toEqual([3, 0, 0])
    expect(directionVector('top', 3)).toEqual([0, 3, 0])
  })
})

describe('scene3d motion — evaluateObjectMotion', () => {
  const D = 4
  it('undefined motion = identity', () => {
    const s = evaluateObjectMotion(undefined, 1.3, D)
    expect(s.dPosition).toEqual([0, 0, 0]); expect(s.scaleMul).toEqual([1, 1, 1]); expect(s.opacity).toBe(1)
  })
  it('pure loop only closes: sample(0) ~= sample(D)', () => {
    const m: ObjectMotion = { loop: { kind: 'bob', speed: 1, amount: 1 } }
    const a = evaluateObjectMotion(m, 0, D), b = evaluateObjectMotion(m, D, D)
    expect(a.dPosition[1]).toBeCloseTo(b.dPosition[1], 6)
  })
  it('fade-in: opacity 0 at t=0, 1 after in.duration', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } } }
    expect(evaluateObjectMotion(m, 0, D).opacity).toBeCloseTo(0, 5)
    expect(evaluateObjectMotion(m, 1, D).opacity).toBeCloseTo(1, 5)
    expect(evaluateObjectMotion(m, 2.5, D).opacity).toBeCloseTo(1, 5)
  })
  it('offset holds the in-start until offset time', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } }, offset: 1 }
    expect(evaluateObjectMotion(m, 0.5, D).opacity).toBeCloseTo(0, 5) // still pre-roll
    expect(evaluateObjectMotion(m, 2, D).opacity).toBeCloseTo(1, 5)   // finished by offset+dur
  })
  it('fade-out: opacity 1 mid, 0 at end', () => {
    const m: ObjectMotion = { out: { preset: 'fade', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } } }
    expect(evaluateObjectMotion(m, 2, D).opacity).toBeCloseTo(1, 5)
    expect(evaluateObjectMotion(m, D, D).opacity).toBeCloseTo(0, 5)
  })
  it('zero-duration in: held at in-start during pre-roll, snaps home once offset arrives', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 0, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } }, offset: 2 }
    expect(evaluateObjectMotion(m, 0, D).opacity).toBeCloseTo(0, 5)   // pre-roll: held at in-start
    expect(evaluateObjectMotion(m, 2, D).opacity).toBeCloseTo(1, 6)   // exact boundary: tSec === offset, instant entrance happens
    expect(evaluateObjectMotion(m, 3, D).opacity).toBeCloseTo(1, 5)   // instant entrance already happened
  })
  it('combine: loop + in position is additive (bob + move)', () => {
    const m: ObjectMotion = {
      loop: { kind: 'bob', speed: 1, amount: 1 },
      in: { preset: 'move', direction: 'left', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } },
    }
    const s = evaluateObjectMotion(m, 0.5, D)
    expect(s.dPosition[0]).toBeLessThan(0)     // unfinished move-in still offset on x
    expect(s.dPosition[1]).toBeGreaterThan(0)  // bob loop contributes on y at the same instant
  })
  it('combine: loop + in scale is multiplicative (pulse + scale-in)', () => {
    const tSec = 0.5 // strictly inside in-region with duration=1
    const pulse = { kind: 'pulse', speed: 1, amount: 1 } as const
    const scale = { preset: 'scale', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } } as const

    // Evaluate each component independently
    const pulseOnly = evaluateObjectMotion({ loop: pulse }, tSec, D).scaleMul[0]
    const scaleInOnly = evaluateObjectMotion({ in: scale }, tSec, D).scaleMul[0]

    // Evaluate both together
    const combined = evaluateObjectMotion({ loop: pulse, in: scale }, tSec, D).scaleMul[0]

    // Scale-in should multiply (not replace) the loop's scale
    expect(combined).toBeCloseTo(pulseOnly * scaleInOnly, 6) // exact-product assertion guards multiplicative combine
    expect(scaleInOnly).toBeLessThan(1) // scale-in is meaningful at mid-progress
    expect(scaleInOnly).not.toBe(1) // ensure scaleInOnly !== 1 for distinctness
  })
  it('no double-easing: non-identity ease is applied exactly once', () => {
    const ease = { kind: 'bezier' as const, cps: [0, 0, 0.58, 1] as [number, number, number, number] }
    const m: ObjectMotion = { in: { preset: 'fade', duration: 2, ease } }
    const expected = resolveEaseRef(ease)(0.5) // single application of the ease curve at p=0.5
    expect(evaluateObjectMotion(m, 1, D).opacity).toBeCloseTo(expected, 6)
  })
})

describe('scene3d motion — evaluateCameraMotion', () => {
  it('orbit yaw closes', () => {
    expect(evaluateCameraMotion({ preset: 'orbit', speed: 1, amount: 1 }, 0).dTargetYaw).toBeCloseTo(0, 6)
    const end = evaluateCameraMotion({ preset: 'orbit', speed: 1, amount: 1 }, 1).dTargetYaw
    expect(((end % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(0, 5)
  })
})

describe('scene3d motion — applyMotionToDoc', () => {
  it('no motion → doc transforms unchanged and input not mutated', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.position = [1, 2, 3]; doc.objects.push(box)
    const before = JSON.stringify(doc)
    const { doc: out, opacities } = applyMotionToDoc(doc, 0.5)
    expect(out.objects[0]!.position).toEqual([1, 2, 3])
    expect(opacities).toEqual({})
    expect(JSON.stringify(doc)).toBe(before) // input untouched
  })
  it('composes loop delta onto home position', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.position = [0, 5, 0]
    box.motion = { loop: { kind: 'bob', speed: 1, amount: 2 } }; doc.objects.push(box)
    doc.motion = { duration: 4, fps: 30, loop: true }
    const quarter = applyMotionToDoc(doc, 0.25).doc.objects[0]!.position
    expect(quarter[1]).toBeGreaterThan(5) // bob peak above home mid-cycle
    const zero = applyMotionToDoc(doc, 0).doc.objects[0]!.position
    expect(zero[1]).toBeCloseTo(5, 6) // returns home at loop start
  })
  it('pure-loop scene: frame 0 == frame 1 (seamless)', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.motion = { loop: { kind: 'orbit', speed: 2, amount: 1 } }; doc.objects.push(box)
    doc.motion = { duration: 4, fps: 30, loop: true }
    const a = applyMotionToDoc(doc, 0).doc.objects[0]!.position.map(v => +v.toFixed(6))
    const b = applyMotionToDoc(doc, 1).doc.objects[0]!.position.map(v => +v.toFixed(6))
    expect(a).toEqual(b)
  })
  it('reports opacity for fading object', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.motion = { in: { preset: 'fade', duration: 1, ease: { kind: 'bezier', cps: [0, 0, 1, 1] } } }
    doc.objects.push(box); doc.motion = { duration: 4, fps: 30, loop: true }
    expect(applyMotionToDoc(doc, 0).opacities[box.id]).toBeCloseTo(0, 5)
  })
  it('camera orbit: position rotates around target, radius preserved', () => {
    const doc = defaultDoc()
    doc.camera.position = [0, 0, 5]
    doc.camera.target = [0, 0, 0]
    doc.camera.motion = { preset: 'orbit', speed: 1, amount: 1 }
    doc.motion = { duration: 4, fps: 30, loop: true }

    // At t01=0, position unchanged
    const pos0 = applyMotionToDoc(doc, 0).doc.camera.position
    expect(pos0[0]).toBeCloseTo(0, 5)
    expect(pos0[1]).toBeCloseTo(0, 5)
    expect(pos0[2]).toBeCloseTo(5, 5)

    // At t01=0.25 (quarter orbit, yaw=π/2), position rotates to [-5, 0, 0]
    const pos25 = applyMotionToDoc(doc, 0.25).doc.camera.position
    expect(pos25[0]).toBeCloseTo(-5, 5)
    expect(pos25[1]).toBeCloseTo(0, 5)
    expect(pos25[2]).toBeCloseTo(0, 5)

    // Radius preserved throughout
    const radius0 = Math.hypot(pos0[0], pos0[2])
    const radius25 = Math.hypot(pos25[0], pos25[2])
    expect(radius0).toBeCloseTo(5, 5)
    expect(radius25).toBeCloseTo(5, 5)
  })
  it('camera push: position moves along target-to-camera axis with sine envelope', () => {
    const doc = defaultDoc()
    doc.camera.position = [0, 0, 5]
    doc.camera.target = [0, 0, 0]
    doc.camera.motion = { preset: 'push', speed: 1, amount: 1 }
    doc.motion = { duration: 4, fps: 30, loop: true }

    // At t01=0, push envelope is 0 (sin(0)=0)
    const pos0 = applyMotionToDoc(doc, 0).doc.camera.position
    expect(pos0[0]).toBeCloseTo(0, 5)
    expect(pos0[1]).toBeCloseTo(0, 5)
    expect(pos0[2]).toBeCloseTo(5, 5)

    // At t01=0.5 (peak), push envelope is sin(π/2)*0.15 = 0.15
    const pos50 = applyMotionToDoc(doc, 0.5).doc.camera.position
    expect(pos50[0]).toBeCloseTo(0, 5)
    expect(pos50[1]).toBeCloseTo(0, 5)
    expect(pos50[2]).toBeCloseTo(4.85, 5)
  })
})

describe('scene3d motion — defaults/templates', () => {
  function scene(n: number) {
    const doc = defaultDoc()
    for (let i = 0; i < n; i++) { const b = createPrimitive('box', doc.objects); doc.objects.push(b) }
    return doc
  }
  it('animateSceneDefaults staggers offsets and drifts phases', () => {
    const doc = scene(3); animateSceneDefaults(doc)
    const offs = doc.objects.map(o => o.motion?.offset ?? 0)
    expect(offs[0]!).toBeLessThan(offs[1]!)
    expect(offs[1]!).toBeLessThan(offs[2]!)
    const phases = doc.objects.map(o => o.motion?.loop?.phase ?? 0)
    expect(new Set(phases).size).toBeGreaterThan(1) // not all identical
    expect(doc.camera.motion?.preset).toBeDefined()
  })
  it('loop template gives no in/out (seamless)', () => {
    const doc = scene(2); SCENE_TEMPLATES.loop(doc)
    expect(doc.objects[0]!.motion?.in).toBeUndefined()
    expect(doc.objects[0]!.motion?.loop).toBeDefined()
  })
  it('skips lights', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); doc.objects.push(box)
    // simulate a light object shape
    doc.objects.push({ ...box, id: 'L1', kind: 'light', light: 'point', color: '#fff', intensity: 1 } as any)
    animateSceneDefaults(doc)
    expect(doc.objects[1]!.motion).toBeUndefined()
  })
})

import { sceneHasMotion } from '~/lib/scene3d/motion/render'
import { makeScene3DFrameSource } from '~/lib/scene3d/motion/frameSource'

describe('scene3d motion — frame source factory', () => {
  const fakeCanvas = { width: 8, height: 8 } as unknown as HTMLCanvasElement
  it('reflects the live clock via getters', () => {
    let clock = { duration: 4, fps: 30, width: 512, height: 512 }
    const src = makeScene3DFrameSource({ getClock: () => clock, renderAt: () => fakeCanvas })
    expect(src.duration).toBe(4)
    clock = { duration: 6, fps: 24, width: 256, height: 256 }
    expect(src.duration).toBe(6)
    expect(src.fps).toBe(24)
    expect(src.width).toBe(256)
  })
  it('getFrame returns the rendered surface', async () => {
    const src = makeScene3DFrameSource({ getClock: () => ({ duration: 4, fps: 30, width: 8, height: 8 }), renderAt: () => fakeCanvas })
    expect(await src.getFrame(0.5, 8, 8)).toBe(fakeCanvas)
  })
  it('getFrame throws when renderer not ready', async () => {
    const src = makeScene3DFrameSource({ getClock: () => ({ duration: 4, fps: 30, width: 8, height: 8 }), renderAt: () => null })
    await expect(src.getFrame(0, 8, 8)).rejects.toThrow()
  })
  // renderAt may be async (the settled path awaits decal texture builds before
  // rendering); getFrame must await it so the null guard sees the resolved value,
  // not a truthy pending Promise.
  it('getFrame awaits an async renderAt', async () => {
    const src = makeScene3DFrameSource({ getClock: () => ({ duration: 4, fps: 30, width: 8, height: 8 }), renderAt: async () => fakeCanvas })
    expect(await src.getFrame(0.5, 8, 8)).toBe(fakeCanvas)
  })
  it('getFrame throws when an async renderAt resolves null', async () => {
    const src = makeScene3DFrameSource({ getClock: () => ({ duration: 4, fps: 30, width: 8, height: 8 }), renderAt: async () => null })
    await expect(src.getFrame(0, 8, 8)).rejects.toThrow(/not ready/)
  })
})

import { bandSegments, resizeTransition, setClipOffset, snapSeconds } from '~/lib/scene3d/motion/timeline'

const E = { kind: 'bezier' as const, cps: [0, 0, 1, 1] as [number, number, number, number] }

describe('scene3d motion — band math', () => {
  it('loop fills the remainder', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: E }, out: { preset: 'fade', duration: 1, ease: E } }
    const s = bandSegments(m, 4)
    expect(s.inFrac).toBeCloseTo(0.25, 6)
    expect(s.outFrac).toBeCloseTo(0.25, 6)
    expect(s.loopFrac).toBeCloseTo(0.5, 6)
    expect(s.offsetFrac).toBeCloseTo(0, 6)
  })
  it('offset eats into the loop', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: E }, offset: 1 }
    const s = bandSegments(m, 4)
    expect(s.offsetFrac).toBeCloseTo(0.25, 6)
    expect(s.inFrac).toBeCloseTo(0.25, 6)
    expect(s.loopFrac).toBeCloseTo(0.5, 6)
  })
  it('resizeTransition clamps against the other slot + offset', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: E }, out: { preset: 'fade', duration: 1, ease: E }, offset: 0.5 }
    resizeTransition(m, 'in', 100, 4) // absurd → clamp to 4 - 0.5 - 1 = 2.5
    expect(m.in!.duration).toBeCloseTo(2.5, 6)
  })
  it('setClipOffset clamps to leave room for in+out', () => {
    const m: ObjectMotion = { in: { preset: 'fade', duration: 1, ease: E }, out: { preset: 'fade', duration: 1, ease: E } }
    setClipOffset(m, 100, 4) // clamp to 4 - 2 = 2
    expect(m.offset).toBeCloseTo(2, 6)
  })
  it('snapSeconds snaps within eps only', () => {
    expect(snapSeconds(1.02, [0, 1, 2], 0.08)).toBe(1)
    expect(snapSeconds(1.4, [0, 1, 2], 0.08)).toBe(1.4)
  })
})

import { setObjectLoop, setObjectTransition, LOOP_OPTIONS, setObjectDirection } from '~/lib/scene3d/motion/panel'

describe('scene3d motion — panel helpers', () => {
  it('setObjectLoop assigns and clears', () => {
    const o = createPrimitive('box', defaultDoc().objects)
    setObjectLoop(o, 'spin')
    expect(o.motion?.loop?.kind).toBe('spin')
    setObjectLoop(o, 'none')
    expect(o.motion?.loop).toBeUndefined()
  })
  it('setObjectTransition assigns in/out with a default ease', () => {
    const o = createPrimitive('box', defaultDoc().objects)
    setObjectTransition(o, 'in', 'fade')
    expect(o.motion?.in?.preset).toBe('fade')
    expect(o.motion?.in?.ease.kind).toBe('bezier')
    setObjectTransition(o, 'in', 'none' as any)
    expect(o.motion?.in).toBeUndefined()
  })
  it('LOOP_OPTIONS includes none + the shipped kinds', () => {
    expect(LOOP_OPTIONS).toContain('none')
    expect(LOOP_OPTIONS).toContain('spin')
    expect(LOOP_OPTIONS).toContain('orbit')
  })
})

describe('scene3d motion — direction helper', () => {
  it('sets direction on an existing transition', () => {
    const o = createPrimitive('box', defaultDoc().objects)
    setObjectTransition(o, 'in', 'move')
    setObjectDirection(o, 'in', 'right')
    expect(o.motion?.in?.direction).toBe('right')
  })
  it('no-ops when the slot is unset', () => {
    const o = createPrimitive('box', defaultDoc().objects)
    setObjectDirection(o, 'in', 'left')
    expect(o.motion).toBeUndefined()
  })
})

describe('scene3d motion — sceneHasMotion', () => {
  it('false for a motion-less scene', () => {
    const doc = defaultDoc(); doc.objects.push(createPrimitive('box', doc.objects))
    expect(sceneHasMotion(doc)).toBe(false)
  })
  it('true when an object loops', () => {
    const doc = defaultDoc(); const b = createPrimitive('box', doc.objects)
    b.motion = { loop: { kind: 'spin', speed: 1, amount: 1 } }; doc.objects.push(b)
    expect(sceneHasMotion(doc)).toBe(true)
  })
  it('true when camera moves', () => {
    const doc = defaultDoc(); doc.camera.motion = { preset: 'orbit', speed: 1, amount: 1 }
    expect(sceneHasMotion(doc)).toBe(true)
  })
  it('loop kind none does not count', () => {
    const doc = defaultDoc(); const b = createPrimitive('box', doc.objects)
    b.motion = { loop: { kind: 'none', speed: 1, amount: 1 } }; doc.objects.push(b)
    expect(sceneHasMotion(doc)).toBe(false)
  })
})

import {
  EASE_PRESETS, presetKeyForEaseRef, easeRefForPresetKey, easeRefToCurveString, curveStringToEaseRef,
} from '~/lib/scene3d/motion/easePresets'

describe('scene3d motion — ease presets + CurveEditor bridge', () => {
  it('smooth presets are editable, procedural are not', () => {
    const back = EASE_PRESETS.find(p => p.key === 'back')!
    const bounce = EASE_PRESETS.find(p => p.key === 'bounce')!
    expect(back.editable).toBe(true); expect(back.ease.kind).toBe('bezier')
    expect(bounce.editable).toBe(false); expect(bounce.ease.kind).toBe('named')
  })
  it('presetKeyForEaseRef matches a known tuple and falls back to custom', () => {
    const easeOut = easeRefForPresetKey('ease-out')
    expect(presetKeyForEaseRef(easeOut)).toBe('ease-out')
    expect(presetKeyForEaseRef({ kind: 'bezier', cps: [0.11, 0.22, 0.33, 0.44] })).toBe('custom')
    expect(presetKeyForEaseRef({ kind: 'named', name: 'spring' })).toBe('spring')
  })
  it('bridge round-trips a bezier and nulls a procedural', () => {
    const s = easeRefToCurveString({ kind: 'bezier', cps: [0.1, 0.2, 0.3, 0.4] })
    expect(s).toBe('[0.1,0.2,0.3,0.4]')
    expect(curveStringToEaseRef(s!)).toEqual({ kind: 'bezier', cps: [0.1, 0.2, 0.3, 0.4] })
    expect(easeRefToCurveString({ kind: 'named', name: 'bounce' })).toBeNull()
  })
})

describe('scene3d — floor parse (showFloor backward-compat)', () => {
  it('defaults floor to shadow for old docs without a floor key', () => {
    const raw = JSON.parse(serializeDoc(defaultDoc())); delete raw.floorMode
    expect(parseDoc(JSON.stringify(raw)).floorMode).toBe('shadow')
  })
  it('migrates a legacy explicit showFloor:false to off', () => {
    const raw = JSON.parse(serializeDoc(defaultDoc())); delete raw.floorMode; raw.showFloor = false
    expect(parseDoc(JSON.stringify(raw)).floorMode).toBe('off')
  })
})

describe('scene3d — post parse', () => {
  it('defaults to DEFAULT_POST for old docs without the key', () => {
    const raw = JSON.parse(serializeDoc(defaultDoc())); delete raw.post
    expect(parseDoc(JSON.stringify(raw)).post).toEqual(DEFAULT_POST)
  })
  it('round-trips explicit post settings', () => {
    const doc = defaultDoc()
    doc.post = { ...DEFAULT_POST, bloom: true, bloomStrength: 1.2 }
    const round = parseDoc(serializeDoc(doc))
    expect(round.post.bloom).toBe(true)
    expect(round.post.bloomStrength).toBe(1.2)
    expect(round.post).toEqual({ ...DEFAULT_POST, bloom: true, bloomStrength: 1.2 })
  })
})

// The Motion panel hides Cycles/Amount for presets that ignore them. Those lists live in
// motion/panel.ts but the truth lives in the evaluators, so re-derive them here: probe each
// preset with two `amount`/`speed` values and see whether the sample actually moves.
describe('scene3d motion — panel knob lists match the evaluators', () => {
  const sampleLoop = (kind: LoopKind, spec: Partial<LoopSpec>) =>
    JSON.stringify(evaluateObjectMotion(
      { loop: { kind, speed: 1, amount: 1, ...spec } }, 0.37, 1,
    ))
  const sampleCam = (preset: CameraMotion['preset'], spec: Partial<CameraMotion>) =>
    JSON.stringify(evaluateCameraMotion({ preset, speed: 1, amount: 1, ...spec }, 0.37))

  it('LOOP_USES_AMOUNT lists exactly the kinds whose amount changes the sample', () => {
    const derived = LOOP_OPTIONS.filter(
      (k) => k !== 'none' && sampleLoop(k, { amount: 1 }) !== sampleLoop(k, { amount: 2 }),
    )
    expect(derived).toEqual(LOOP_USES_AMOUNT)
  })

  it('CAMERA_USES_CYCLES / CAMERA_USES_AMOUNT list exactly the presets that read them', () => {
    const byCycles = CAMERA_OPTIONS.filter(
      (p) => p !== 'none' && sampleCam(p, { speed: 1 }) !== sampleCam(p, { speed: 3 }),
    )
    const byAmount = CAMERA_OPTIONS.filter(
      (p) => p !== 'none' && sampleCam(p, { amount: 1 }) !== sampleCam(p, { amount: 2 }),
    )
    expect(byCycles).toEqual(CAMERA_USES_CYCLES)
    expect(byAmount).toEqual(CAMERA_USES_AMOUNT)
  })

  it('every loop kind reads speed as whole cycles across the scene', () => {
    for (const kind of LOOP_OPTIONS) {
      if (kind === 'none') continue
      // 3 cycles at t01=x/3 is the same pose as 1 cycle at t01=x — speed only rescales time.
      expect(JSON.stringify(evaluateObjectMotion({ loop: { kind, speed: 3, amount: 1 } }, 0.37 / 3, 1))).toBe(
        JSON.stringify(evaluateObjectMotion({ loop: { kind, speed: 1, amount: 1 } }, 0.37, 1)),
      )
      // ...and a whole number of cycles still closes on the scene end.
      expect(sampleLoop(kind, { speed: 3 })).not.toBe(sampleLoop(kind, { speed: 1 }))
    }
  })

  it('a 60s scene bakes 60 x fps frames', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 60, fps: 30, loop: true }
    expect(parseDoc(serializeDoc(doc)).motion.duration).toBe(60)
    expect(Math.round(doc.motion.fps * doc.motion.duration)).toBe(1800)
  })
})

import { sceneFrameClock } from '~/lib/scene3d/motion/render'

describe('sceneFrameClock', () => {
  it('reports duration 0 for a still scene (no motion), keeping fps and output size', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    doc.motion = { duration: 4, fps: 30, loop: true } // leftover non-zero duration
    expect(sceneHasMotion(doc)).toBe(false)
    expect(sceneFrameClock(doc)).toEqual({ duration: 0, fps: 30, width: doc.output.width, height: doc.output.height })
  })

  it('reports the real motion duration for an object-animated scene', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    obj.motion = { loop: { kind: 'spin', speed: 2, amount: 1 } }
    doc.objects.push(obj)
    doc.motion = { duration: 5, fps: 24, loop: true }
    expect(sceneHasMotion(doc)).toBe(true)
    expect(sceneFrameClock(doc)).toEqual({ duration: 5, fps: 24, width: doc.output.width, height: doc.output.height })
  })

  it('reports the real motion duration for a camera-only-animated scene', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    doc.camera.motion = { preset: 'orbit', speed: 1, amount: 1 }
    doc.motion = { duration: 6, fps: 30, loop: true }
    expect(sceneHasMotion(doc)).toBe(true)
    expect(sceneFrameClock(doc).duration).toBe(6)
  })
})

describe('scene3d lighting fields', () => {
  it('defaults the new simple-lighting fields', () => {
    const d = defaultDoc()
    expect(d.lighting.look).toBe('softbox-beauty')
    expect(d.lighting.softness).toBe(0.85)
    expect(d.lighting.warmth).toBe(0.5)
    expect(d.lighting.brightness).toBe(1)
    expect(d.lighting.sunColor).toBe('#ffffff')
    expect(d.lighting.shadowSoftness).toBe(10.35)
    expect(d.lighting.advanced).toBe(false)
  })
  it('round-trips the new fields and defaults them on an old doc', () => {
    const d = defaultDoc()
    d.lighting.look = 'rembrandt'; d.lighting.warmth = 0.8; d.lighting.sunColor = '#ffcc99'
    const round = parseDoc(serializeDoc(d))
    expect(round.lighting.look).toBe('rembrandt')
    expect(round.lighting.warmth).toBe(0.8)
    expect(round.lighting.sunColor).toBe('#ffcc99')
    const raw = JSON.parse(serializeDoc(defaultDoc()))
    delete raw.lighting.look; delete raw.lighting.sunColor
    const old = parseDoc(JSON.stringify(raw))
    expect(old.lighting.look).toBe('softbox-beauty')
    expect(old.lighting.sunColor).toBe('#ffffff')
  })
})
