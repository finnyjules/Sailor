// frontend/tests/unit/studio-moves-panel-change.unit.spec.ts
// @vitest-environment happy-dom
//
// MovesPanel's real behaviour under the `at`/`loop` model
// (`docs/superpowers/specs/2026-09-04-motion-timeline-design.md` §5): it
// renders the SELECTED move's own controls when `selectedId` names one, and
// the clip settings when nothing is selected. Filename kept from the
// pre-timeline "Change" spec this replaces — MoveCard.vue and its
// replace-in-place merge logic are retired; Change is now a simple
// `open-gallery` emit the surface (Task 7) resolves via `patch-move`.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MovesPanel from '~/components/vue-canvas/motion/moves/MovesPanel.vue'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move, MotionClip } from '~/lib/studio/moves/types'

const EASE = { kind: 'named', name: 'smooth' } as const

const TRACK_MOVE: Move = {
  id: 'm1',
  kind: 'tracks',
  presetId: 'custom',
  at: 0,
  duration: 1.2,
  loop: false,
  ease: EASE,
  tracks: [{ path: 'motion.slant', from: 0, to: 45 }],
}

const PRESET_MOVE: Move = {
  id: 'm2',
  kind: 'preset',
  presetId: 'fade-in',
  at: 0,
  duration: 0.8,
  loop: false,
  ease: EASE,
}

const PRESET_PAIRS: Record<string, string> = { 'fade-in': 'fade-out', 'fade-out': 'fade-in' }

// No `kinds.tracks` entry — 'tracks' is the universal kind, never listed in
// `kinds` (adapter.ts's `MoveKindDef` doc). `kinds.preset` has no cardBody
// either, so its card falls through to the "no settings yet" line — this
// suite only needs its presetId to exercise the In/Out toggle.
const ADAPTER: MovesAdapter<unknown> = {
  kinds: { preset: { label: 'Preset' } },
  gallery: () => [],
  animatable: () => [{ label: 'Motion', dials: [{ path: 'motion.slant', label: 'Slant', min: -45, max: 45 }] }],
  availability: () => null,
  direction: (id) => (id in PRESET_PAIRS ? (id === 'fade-in' ? 'in' : 'out') : null),
  flip: (id) => PRESET_PAIRS[id] ?? id,
}

function mountPanel(moves: Move[], selectedId: string | null) {
  const clip: MotionClip = { moves, duration: 4, fps: 30 }
  return mount(MovesPanel, { props: { clip, adapter: ADAPTER, cfg: {}, selectedId } })
}

describe('MovesPanel — selected move', () => {
  it('renders the selected move\'s label and Length', () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    expect(w.text()).toContain('Custom · slant')
    const duration = w.find('input[type="number"]')
    expect((duration.element as HTMLInputElement).value).toBe('1.2')
  })

  it('toggling Loop emits patch-move with the flipped loop flag', async () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    const loopToggle = w.find('button[role="switch"]')
    expect(loopToggle.attributes('aria-checked')).toBe('false')
    await loopToggle.trigger('click')

    const patches = w.emitted('patch-move') as Array<[Move, Partial<Move>]>
    expect(patches).toBeTruthy()
    const [move, partial] = patches![patches!.length - 1]!
    expect(move).toEqual(TRACK_MOVE)
    expect(partial).toEqual({ loop: true })
  })

  it('has no In/Out toggle for a move whose preset is unpaired', () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    expect(w.text()).not.toContain('Direction')
  })

  it('the In/Out toggle flips presetId via adapter.flip', async () => {
    const w = mountPanel([PRESET_MOVE], 'm2')
    expect(w.text()).toContain('Direction')
    const outBtn = w.findAll('button').find((b) => b.text() === 'Out')
    expect(outBtn).toBeTruthy()
    await outBtn!.trigger('click')

    const patches = w.emitted('patch-move') as Array<[Move, Partial<Move>]>
    const [move, partial] = patches![patches!.length - 1]!
    expect(move).toEqual(PRESET_MOVE)
    expect(partial).toEqual({ presetId: 'fade-out' })
  })

  it('the Change button emits open-gallery, not a replace/remove', async () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    const changeBtn = w.findAll('button').find((b) => b.text() === 'Change')
    await changeBtn!.trigger('click')
    expect(w.emitted('open-gallery')).toHaveLength(1)
    expect(w.emitted('remove-move')).toBeFalsy()
  })

  it('the Remove button emits remove-move with the full move', async () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    await w.find('button[title="Remove move"]').trigger('click')
    expect(w.emitted('remove-move')).toEqual([[TRACK_MOVE]])
  })

  it('editing a From/To track input emits patch-move with the updated tracks array', async () => {
    const w = mountPanel([TRACK_MOVE], 'm1')
    const inputs = w.findAll('input[type="number"]')
    // duration is first; from is second
    const fromInput = inputs[1]!
    await fromInput.setValue('10')
    await fromInput.trigger('change')
    const patches = w.emitted('patch-move') as Array<[Move, Partial<Move>]>
    const [, partial] = patches![patches!.length - 1]!
    expect(partial.tracks).toEqual([{ path: 'motion.slant', from: 10, to: 45 }])
    // the original move prop must not have been mutated
    expect(TRACK_MOVE.tracks).toEqual([{ path: 'motion.slant', from: 0, to: 45 }])
  })
})

describe('MovesPanel — nothing selected', () => {
  it('renders the clip settings instead of a move', () => {
    const w = mountPanel([TRACK_MOVE], null)
    expect(w.text()).toContain('Clip')
    expect(w.text()).toContain('Length')
    expect(w.text()).toContain('Frame rate')
    expect(w.text()).not.toContain('Custom · slant')
  })

  it('changing the Length slider emits patch-clip', async () => {
    const w = mountPanel([], null)
    // Length was a native range input; since the StudioSlider migration it is the house slider
    // row (a scrub track, no <input type="range">), so drive it the way the other panel specs
    // do — through the component's own model event.
    const slider = w.findAllComponents({ name: 'StudioSlider' }).find(sl => sl.props('label') === 'Length')
    expect(slider, 'the clip Length slider').toBeTruthy()
    await slider!.vm.$emit('update:modelValue', 6)
    expect(w.emitted('patch-clip')).toBeTruthy()
    expect(w.emitted('patch-clip')!.at(-1)![0]).toEqual({ duration: 6 })
  })

  it('the Add move button emits open-gallery', async () => {
    const w = mountPanel([], null)
    const addBtn = w.findAll('button').find((b) => b.text().includes('Add move'))
    expect(addBtn).toBeTruthy()
    await addBtn!.trigger('click')
    expect(w.emitted('open-gallery')).toHaveLength(1)
  })
})
