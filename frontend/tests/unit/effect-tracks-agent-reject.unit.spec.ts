import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { describeCompositor, applyCompositorCommand, COMPOSITOR_HINT_CEILING, type CompositorState } from '~/lib/agent/surfaces/compositor'

// F8 · Effect-dial motion authoring, now AGENT-DRIVABLE via the novel `animateDial` op
// (F-cap Task 3, Julien "run with it" 2026-09-15). This file used to be the deliberate
// tripwire pinning the deferred decision: the agent had NO motion vocabulary and the surface
// sat at the full hint budget. That decision landed — the ceiling was raised and animateDial
// added — so the motion-reject expectations here FLIPPED to accept, ON PURPOSE.
//
// The one boundary that STAYS a reject: motion is a FRAME doc, never a layer prop or an effect
// field. setLayerProps refuses a { motion } patch and setLayerEffect drops a smuggled track —
// tracks only reach the doc through animateDial.

const state = (): CompositorState => ({
  layers: [
    {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3,
      fill: '#fff', stroke: '', strokeWidth: 0, radius: 0,
      effects: [{ id: 'e-grain', type: 'grain', amount: 0.5, size: 3, visible: true }],
    } as any,
  ] as LocalLayer[],
})

// The shape a Motion-tab track carries (lib/motion/effectTracks.ts). No layer-prop / effect op accepts it.
const track = { target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0 }, { t: 2, v: 0.9 }] }

describe('F8 · effect-dial motion is agent-drivable via animateDial (F-cap Task 3)', () => {
  it('the compositor hint ceiling is at the F-cap Task-3 value 27700', () => {
    expect(COMPOSITOR_HINT_CEILING).toBe(27700)
  })

  it('animateDial authors a two-keyframe timeline band on the frame motion doc', () => {
    const r = applyCompositorCommand(state(), {
      op: 'animateDial', target: 'L1',
      args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9 },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    const bands = r.template.motion?.motionx ?? []
    const tr = bands.find(t => t.path === 'layers.L1.effects.e-grain.amount')
    expect(tr).toBeTruthy()
    expect(tr!.keyframes.length).toBe(2)
    // from at the start keyframe, to at the end keyframe (sorted ascending by t).
    expect(tr!.keyframes[0]!.value).toBe(0)
    expect(tr!.keyframes.at(-1)!.value).toBe(0.9)
    expect(tr!.keyframes[0]!.t).toBeLessThan(tr!.keyframes.at(-1)!.t)
  })

  it('animateDial rejects an effect kind not on the layer', () => {
    const r = applyCompositorCommand(state(), {
      op: 'animateDial', target: 'L1',
      args: { effect: 'bloom', dial: 'threshold', from: 0, to: 1 },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')
  })

  it('animateDial rejects a non-animatable / unknown dial (the dead-control guard)', () => {
    // `seed` is deliberately excluded from the dial schema; `nope` is not a dial at all.
    expect(applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'seed', from: 0, to: 1 } }).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'nope', from: 0, to: 1 } }).ok).toBe(false)
  })

  it('setLayerProps STILL refuses a { motion: { tracks } } patch — motion is not a layer prop', () => {
    const r = applyCompositorCommand(state(), { op: 'setLayerProps', target: 'L1', args: { patch: { motion: { tracks: [track] } } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/motion/)
  })

  it('an invented effect-dial-track op is still out of vocabulary (only animateDial is the verb)', () => {
    expect(applyCompositorCommand(state(), { op: 'setEffectDialTrack', target: 'L1', args: { motion: { tracks: [track] } } } as any).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'addMotionTrack', args: { motion: { tracks: [track] } } } as any).ok).toBe(false)
  })

  it('setLayerEffect STILL cannot smuggle a track onto an effect — the sanitizer drops the unknown field', () => {
    // A track lives on the motion doc, never on the effect instance. Even if a model tries to
    // hang one off a valid grain edit, the whitelisting sanitizer must never persist it.
    const r = applyCompositorCommand(state(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'grain', amount: 0.6, tracks: [track] } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects.find((e: any) => e.type === 'grain')
    expect(fx.amount).toBe(0.6)         // the legitimate edit still applies
    expect(fx.tracks).toBeUndefined()   // the smuggled track does not
  })

  it('the described agent vocabulary now lists animateDial (the ONE motion op)', () => {
    const cmds = describeCompositor(state()).commands
    const motionOps = cmds.filter(c => /track|dial|motion|keyframe|animat/i.test(String(c.op)))
    expect(motionOps.map(c => c.op)).toEqual(['animateDial'])
  })
})
