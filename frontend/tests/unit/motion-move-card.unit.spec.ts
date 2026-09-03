// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MoveCard from '~/components/vue-canvas/motion/moves/MoveCard.vue'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move } from '~/lib/studio/moves/types'

const EASE = { kind: 'named', name: 'smooth' } as const
const PLAY = { mode: 'once', times: 1 } as const

const TRACK_MOVE: Move = {
  id: 'm1',
  phase: 'loop',
  kind: 'tracks',
  presetId: 'custom',
  duration: 1.2,
  ease: EASE,
  play: PLAY,
  tracks: [{ path: 'motion.slant', from: 0, to: 45 }],
}

// No `kinds.tracks` entry — 'tracks' is the universal kind every studio
// gets for free, never listed in `kinds` (adapter.ts's `MoveKindDef` doc).
const ADAPTER: MovesAdapter<unknown> = {
  kinds: {},
  gallery: () => [],
  animatable: () => [{ label: 'Motion', dials: [{ path: 'motion.slant', label: 'Slant', min: -45, max: 45 }] }],
  availability: () => null,
}

function mountCard(open = true) {
  return mount(MoveCard, { props: { move: TRACK_MOVE, adapter: ADAPTER, cfg: {}, open } })
}

describe('MoveCard', () => {
  it('shows the move label and phase tag on the collapsed row', () => {
    const w = mountCard(false)
    expect(w.text()).toContain('Custom · slant')
    expect(w.text()).toContain('Loop')
  })

  it('emits toggle when the collapsed row is clicked', async () => {
    const w = mountCard(false)
    await w.get('.group').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })

  it('renders a labelled From/To pair for a tracks move when open', () => {
    const w = mountCard(true)
    expect(w.text()).toContain('Slant')
    const inputs = w.findAll('input[type="number"]')
    // duration input + from + to
    const values = inputs.map((i) => (i.element as HTMLInputElement).value)
    expect(values).toContain('0')
    expect(values).toContain('45')
  })

  it('emits patch with an updated tracks array when From is edited', async () => {
    const w = mountCard(true)
    const inputs = w.findAll('input[type="number"]')
    // duration is first; from is second
    const fromInput = inputs[1]!
    await fromInput.setValue('10')
    await fromInput.trigger('change')
    const patches = w.emitted('patch') as Array<[Partial<Move>]>
    expect(patches).toBeTruthy()
    const last = patches![patches!.length - 1]![0]
    expect(last.tracks).toEqual([{ path: 'motion.slant', from: 10, to: 45 }])
    // the original move prop must not have been mutated
    expect(TRACK_MOVE.tracks).toEqual([{ path: 'motion.slant', from: 0, to: 45 }])
  })

  it('emits remove when the delete button is clicked', async () => {
    const w = mountCard(false)
    await w.get('button[title="Remove move"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    // must not also toggle (the click is stopped from bubbling to the row)
    expect(w.emitted('toggle')).toBeFalsy()
  })

  it('emits change when the Change button is clicked', async () => {
    const w = mountCard(true)
    const buttons = w.findAll('button').filter((b) => b.text() === 'Change')
    expect(buttons).toHaveLength(1)
    await buttons[0]!.trigger('click')
    expect(w.emitted('change')).toHaveLength(1)
  })
})
