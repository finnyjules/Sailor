import { describe, it, expect } from 'vitest'
import { layerAnimationToTracks, migrateLayerAnimations, UNCONVERTIBLE_PRESETS } from '~/lib/motionx/adapter/migrateLayerAnimation'
import { evaluateAnimation } from '~/lib/motion/evaluate'
import { composeEffectiveLayer } from '~/lib/motion/paint'
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const motion = { fps: 30, duration: 4 }
const dims = { w: 1000, h: 1000 }
const rect = (animation: any, over: any = {}) => ({ id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 10, opacity: 0.8, w: 0.3, h: 0.2, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0, animation, ...over }) as unknown as LocalLayer

/** What the OLD engine shows at t (whole layer). */
function legacy(l: LocalLayer, t: number) {
  const st = evaluateAnimation((l as any).animation, t, motion as any, 1)
  if (!st.visible) return { x: l.x, y: l.y, rotation: l.rotation, opacity: 0, scale: 1 }
  const e = composeEffectiveLayer(l, st, dims.w, dims.h)
  return { x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity, scale: st.layer.scale * (st.units?.[0]?.scale ?? 1) }
}
/** What the converted bands show at t. */
function converted(l: LocalLayer, tracks: any[], t: number) {
  const { animation: _a, ...bare } = l as any
  const out = applyMotionxTracks([bare], tracks, t)[0] as any
  return { x: out.x, y: out.y, rotation: out.rotation, opacity: out.opacity, scale: out.motionScale ?? out.scale ?? 1 }
}
function expectParity(l: LocalLayer) {
  const tracks = layerAnimationToTracks(l, motion as any, dims, [])!
  expect(tracks).not.toBeNull()
  for (let k = 0; k <= 120; k++) {
    const t = k / 30
    // window edges are a 1-frame ramp in band form; skip the frame right at an edge
    const a = legacy(l, t), b = converted(l, tracks, t)
    // Operator precedence in the original form (`a && b || c && d`) only ever paired a
    // hidden/visible check with a look-AHEAD-or-look-BEHIND check that both describe the
    // RISING edge (window opening); it never fired for the FALLING edge (window closing),
    // even though the comment above says "an edge", not "the opening edge". Parenthesized
    // explicitly and extended so both directions of the step are covered symmetrically.
    const hiddenAt = (tt: number) => legacy(l, tt).opacity === 0
    const edge = (hiddenAt(t) !== hiddenAt(t + 1 / 30)) || (hiddenAt(t) !== hiddenAt(Math.max(0, t - 1 / 30)))
    if (edge) continue
    expect(b.x, `x @${t}`).toBeCloseTo(a.x, 2)
    expect(b.y, `y @${t}`).toBeCloseTo(a.y, 2)
    expect(b.opacity, `opacity @${t}`).toBeCloseTo(a.opacity, 2)
    expect(b.scale, `scale @${t}`).toBeCloseTo(a.scale, 2)
    expect(Math.abs(b.rotation - a.rotation), `rotation @${t}`).toBeLessThan(0.6)
  }
  return tracks
}

describe('layerAnimationToTracks', () => {
  it('fade in: one opacity band from 0 to the layer opacity, nothing else', () => {
    const tracks = expectParity(rect({ offset: 0, in: { presetId: 'fade-in', duration: 0.8 } }))
    expect(tracks.map((t) => t.path)).toEqual(['layers.L1.opacity'])
    const kf = tracks[0]!.keyframes
    expect(kf[0]).toMatchObject({ t: 0, value: 0 })
    expect(kf.at(-1)!.value).toBeCloseTo(0.8, 6)
  })
  it('slide up + float loop + fade out, inside a 0.5s–3.5s window', () => {
    const tracks = expectParity(rect({ offset: 0.5, duration: 3, in: { presetId: 'slide-up', duration: 0.6 }, loop: { presetId: 'float', duration: 1.5 }, out: { presetId: 'fade-out', duration: 0.5 } }))
    expect(new Set(tracks.map((t) => t.path))).toEqual(new Set(['layers.L1.x', 'layers.L1.y', 'layers.L1.opacity']))
  })
  it('spin + grow in (rotation, scale, opacity) and an elastic drop', () => {
    expectParity(rect({ offset: 0, in: { presetId: 'spin-in', duration: 1 } }))
    expectParity(rect({ offset: 0, in: { presetId: 'elastic-drop', duration: 1.2 } }))
  })
  it('hand keyframes compose with a preset, exactly as the old engine did', () => {
    expectParity(rect({ offset: 0, keyframes: [{ t: 0, dx: 0 }, { t: 2, dx: 0.2, rotation: 45 }], in: { presetId: 'fade-in', duration: 0.5 } }))
  })
  it('bands stay small: a 4s sine loop simplifies to far fewer points than frames', () => {
    const tracks = layerAnimationToTracks(rect({ offset: 0, loop: { presetId: 'sway', duration: 2 } }), motion as any, dims, [])!
    expect(tracks[0]!.keyframes.length).toBeLessThan(60)
  })
  it('a plain fade in becomes a tidy two-point eased band', () => {
    const tracks = layerAnimationToTracks(rect({ offset: 0, in: { presetId: 'fade-in', duration: 0.8 } }), motion as any, dims, [])!
    const kf = tracks[0]!.keyframes
    expect(kf.length).toBeLessThanOrEqual(3)            // 0 → 0.8s ramp (+ at most a hold point)
    expect(kf[0]).toMatchObject({ t: 0, value: 0, ease: 'easeOut' })
  })
  it('slide up is two tidy bands (position + opacity), not dozens of points', () => {
    const tracks = layerAnimationToTracks(rect({ offset: 0, in: { presetId: 'slide-up', duration: 0.6 } }), motion as any, dims, [])!
    for (const t of tracks) expect(t.keyframes.length, t.path).toBeLessThanOrEqual(3)
  })
  it('a back-out grow uses an exact overshoot curve instead of a point cloud', () => {
    const tracks = layerAnimationToTracks(rect({ offset: 0, in: { presetId: 'grow-in', duration: 1 } }), motion as any, dims, [])!
    const scale = tracks.find((t) => t.path.endsWith('.scale'))!
    expect(scale.keyframes.length).toBeLessThanOrEqual(4)
    expect(Array.isArray(scale.keyframes[0]!.ease)).toBe(true)
  })
  it('refuses masks / flips / copies, empty shells, and layers that already have transform bands', () => {
    for (const id of UNCONVERTIBLE_PRESETS) {
      expect(layerAnimationToTracks(rect({ offset: 0, in: { presetId: id, duration: 1 } }), motion as any, dims, [])).toBeNull()
    }
    expect(layerAnimationToTracks(rect({ offset: 0 }), motion as any, dims, [])).toBeNull()
    expect(layerAnimationToTracks(rect(undefined), motion as any, dims, [])).toBeNull()
    const band = { path: 'layers.L1.rotation', type: 'number' as const, keyframes: [{ t: 0, value: 0, ease: 'linear' as const }] }
    expect(layerAnimationToTracks(rect({ offset: 0, in: { presetId: 'fade-in', duration: 1 } }), motion as any, dims, [band])).toBeNull()
  })
})

describe('migrateLayerAnimations', () => {
  it('nothing to convert → same references', () => {
    const layers = [rect(undefined)]
    const out = migrateLayerAnimations(layers, motion as any, dims)
    expect(out.layers).toBe(layers)
    expect(out.converted).toEqual([])
  })
  it('removes `animation` from converted layers and appends their bands; leaves the rest', () => {
    const a = rect({ offset: 0, in: { presetId: 'fade-in', duration: 1 } })
    const b = rect({ offset: 0, in: { presetId: 'mask-up', duration: 1 } }, { id: 'L2' })
    const out = migrateLayerAnimations([a, b], { ...motion, motionx: [] } as any, dims)
    expect(out.converted).toEqual(['L1'])
    expect('animation' in (out.layers[0] as any)).toBe(false)
    expect((out.layers[1] as any).animation).toBeTruthy()
    expect(out.motionx.map((t) => t.path)).toEqual(['layers.L1.opacity'])
  })
  // Regression: CompositorModal used to pass the 1:1 `canvasDisplay` placeholder as `dims`
  // on every frame open, instead of the frame's real aspect — `composeEffectiveLayer` scales
  // vertical displacement by W/H, so a non-square frame (e.g. 1280×720) baked wrong `y` values.
  // This proves the ratio matters and pins the correct value for a real 16:9 frame.
  it('the y band depends on the frame aspect, not just w/h magnitude', () => {
    const layer = rect({ offset: 0, in: { presetId: 'slide-up', duration: 0.6 } })
    const square = layerAnimationToTracks(layer, motion as any, { w: 1000, h: 1000 }, [])!
    const wide = layerAnimationToTracks(layer, motion as any, { w: 1280, h: 720 }, [])!
    const ySquare = square.find((t) => t.path.endsWith('.y'))!
    const yWide = wide.find((t) => t.path.endsWith('.y'))!
    expect(yWide.keyframes[0]!.t).toBe(0)
    expect(ySquare.keyframes[0]!.t).toBe(0)
    expect(yWide.keyframes[0]!.value as number).not.toBeCloseTo(ySquare.keyframes[0]!.value as number, 3)
    const st = evaluateAnimation((layer as any).animation, 0, motion as any, 1)
    const expected = composeEffectiveLayer(layer, st, 1280, 720).y
    expect(yWide.keyframes[0]!.value as number).toBeCloseTo(expected, 3)
  })
})
