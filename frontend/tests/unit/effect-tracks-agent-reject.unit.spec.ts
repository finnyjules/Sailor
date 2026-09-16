import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { describeCompositor, applyCompositorCommand, COMPOSITOR_HINT_CEILING, type CompositorState } from '~/lib/agent/surfaces/compositor'

// F8 Task 7 · Effect-dial motion is a UI-ONLY slice. The Motion tab authors the tracks
// (`sailor_motion.tracks`); the AGENT gains NO vocabulary for them this slice. Resolved with
// Julien 2026-09-15: the "animate the grain 0→50" agent verb waits on the hint-ceiling
// decision Julien owns (the surface sits at 26248/26250, effectively full). This unit is the
// deliberate tripwire that pins that decision.
//
// ⚠ THIS TEST FLIPS WHEN THE HINT-CEILING SLICE LANDS. Julien decided 2026-09-15 to raise the
//   cap and add F5/F6/F7/F8 agent vocabulary in a follow-up. When that lands, expect a new op
//   (or an accepted `motion.tracks` patch) AND a raised COMPOSITOR_HINT_CEILING — update this
//   file THEN, on purpose. Do not loosen it to make an unrelated change compile.

const state = (): CompositorState => ({
  layers: [
    {
      id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3,
      fill: '#fff', stroke: '', strokeWidth: 0, radius: 0,
      effects: [{ id: 'e-grain', type: 'grain', amount: 0.5, size: 3, visible: true }],
    } as any,
  ] as LocalLayer[],
})

// The shape a Motion-tab track carries (lib/motion/effectTracks.ts). No agent op accepts it.
const track = { target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0 }, { t: 2, v: 0.9 }] }

describe('F8 · effect-dial motion is agent-invisible this slice', () => {
  it('the compositor hint ceiling is at the F-cap value 26600 (raised for F6/F7 plain-dial vocab)', () => {
    expect(COMPOSITOR_HINT_CEILING).toBe(26600)
  })

  it('setLayerProps refuses a { motion: { tracks } } patch — motion is not a common layer prop', () => {
    const r = applyCompositorCommand(state(), { op: 'setLayerProps', target: 'L1', args: { patch: { motion: { tracks: [track] } } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/motion/)
  })

  it('an invented effect-dial-track op is out of vocabulary (rejected like any unknown op)', () => {
    expect(applyCompositorCommand(state(), { op: 'setEffectDialTrack', target: 'L1', args: { motion: { tracks: [track] } } } as any).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'addMotionTrack', args: { motion: { tracks: [track] } } } as any).ok).toBe(false)
  })

  it('setLayerEffect cannot smuggle a track onto an effect — the sanitizer drops the unknown field', () => {
    // A track lives on the motion doc, never on the effect instance. Even if a model tries to
    // hang one off a valid grain edit, the whitelisting sanitizer must never persist it.
    const r = applyCompositorCommand(state(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'grain', amount: 0.6, tracks: [track] } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects.find((e: any) => e.type === 'grain')
    expect(fx.amount).toBe(0.6)         // the legitimate edit still applies
    expect(fx.tracks).toBeUndefined()   // the smuggled track does not
  })

  it('the described agent vocabulary lists no motion / track / dial / keyframe op', () => {
    const cmds = describeCompositor(state()).commands
    expect(cmds.some(c => /track|dial|motion|keyframe|animat/i.test(String(c.op)))).toBe(false)
  })
})
