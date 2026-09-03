// frontend/tests/unit/studio-moves-panel-change.unit.spec.ts
// @vitest-environment happy-dom
//
// Covers the "Change" bug fix: a card's Change button used to delete the
// move (see VectorTypeSurface.vue's old onChangeMove). MovesPanel now owns
// the swap itself — Change reopens the shared gallery pre-aimed at the
// move's own phase, and a pick there comes back as `replace-move` with the
// old move's id (and, for a same-phase pick, its duration/ease/play) kept.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MovesPanel from '~/components/vue-canvas/motion/moves/MovesPanel.vue'
import MoveGallery from '~/components/vue-canvas/motion/moves/MoveGallery.vue'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move, MotionClip } from '~/lib/studio/moves/types'

const EASE = { kind: 'named', name: 'smooth' } as const
const PLAY = { mode: 'repeat', times: 3 } as const

const CUSTOM_MOVE: Move = {
  id: 'm1',
  phase: 'loop',
  kind: 'tracks',
  presetId: 'custom',
  duration: 1.2,
  ease: EASE,
  play: PLAY,
  tracks: [{ path: 'motion.slant', from: 0, to: 45 }],
}

// No `kinds.tracks` entry — 'tracks' is the universal kind (adapter.ts's
// `MoveKindDef` doc), so this move's card falls back to the plain tracks
// editor, which is the only one that renders a "Change" button.
const ADAPTER: MovesAdapter<unknown> = {
  kinds: {},
  gallery: () => [],
  animatable: () => [{ label: 'Motion', dials: [{ path: 'motion.slant', label: 'Slant', min: -45, max: 45 }] }],
  availability: () => null,
}

function mountPanel(clip: MotionClip, openMoveId: string | null = CUSTOM_MOVE.id) {
  return mount(MovesPanel, {
    props: { clip, adapter: ADAPTER, cfg: {}, openMoveId },
  })
}

describe('MovesPanel Change-in-place', () => {
  it('opens the gallery pre-selected to the move\'s own phase, not deleting it', async () => {
    const clip: MotionClip = { moves: [CUSTOM_MOVE], duration: 4, fps: 30 }
    const w = mountPanel(clip)

    await w.find('button[title="Remove move"]').exists() // sanity: card rendered
    // The Change button lives inside the open card's fallback tracks editor.
    const changeBtn = w.findAll('button').find(b => b.text() === 'Change')
    expect(changeBtn).toBeTruthy()
    await changeBtn!.trigger('click')

    const gallery = w.findComponent(MoveGallery)
    expect(gallery.exists()).toBe(true)
    expect(gallery.props('initialPhase')).toBe('loop')

    // The move itself must NOT have been deleted just by opening the gallery.
    expect(w.emitted('remove-move')).toBeFalsy()
    expect(w.emitted('replace-move')).toBeFalsy()
  })

  it('a same-phase pick swaps kind/tracks but keeps the old id, duration, ease and play', async () => {
    const clip: MotionClip = { moves: [CUSTOM_MOVE], duration: 4, fps: 30 }
    const w = mountPanel(clip)
    const changeBtn = w.findAll('button').find(b => b.text() === 'Change')
    await changeBtn!.trigger('click')

    const picked: Move = {
      id: '__candidate__',
      phase: 'loop',
      kind: 'tracks',
      presetId: 'custom',
      duration: 9,
      ease: { kind: 'named', name: 'bounce' },
      play: { mode: 'once', times: 1 },
      tracks: [{ path: 'motion.otherDial', from: 0, to: 1 }],
    }
    await w.findComponent(MoveGallery).vm.$emit('add', picked)

    const replaced = w.emitted('replace-move')
    expect(replaced).toHaveLength(1)
    const [oldMove, newMove] = replaced![0] as [Move, Move]
    expect(oldMove).toEqual(CUSTOM_MOVE)
    expect(newMove.id).toBe(CUSTOM_MOVE.id) // identity preserved
    expect(newMove.duration).toBe(CUSTOM_MOVE.duration) // kept — same phase
    expect(newMove.ease).toEqual(CUSTOM_MOVE.ease) // kept — same phase
    expect(newMove.play).toEqual(CUSTOM_MOVE.play) // kept — same phase
    expect(newMove.tracks).toEqual(picked.tracks) // taken from the new pick
    expect(w.emitted('add-move')).toBeFalsy() // never a plain add
    expect(w.emitted('remove-move')).toBeFalsy() // never a delete
  })

  it('a different-phase pick uses the new duration/ease/play instead of the old ones', async () => {
    const clip: MotionClip = { moves: [CUSTOM_MOVE], duration: 4, fps: 30 }
    const w = mountPanel(clip)
    const changeBtn = w.findAll('button').find(b => b.text() === 'Change')
    await changeBtn!.trigger('click')

    const picked: Move = {
      id: '__candidate__',
      phase: 'in', // different from CUSTOM_MOVE.phase ('loop')
      kind: 'tracks',
      presetId: 'custom',
      duration: 0.6,
      ease: { kind: 'named', name: 'overshoot' },
      play: { mode: 'once', times: 1 },
      tracks: [{ path: 'motion.otherDial', from: 0, to: 1 }],
    }
    await w.findComponent(MoveGallery).vm.$emit('add', picked)

    const [, newMove] = w.emitted('replace-move')![0] as [Move, Move]
    expect(newMove.id).toBe(CUSTOM_MOVE.id)
    expect(newMove.phase).toBe('in')
    expect(newMove.duration).toBe(0.6)
    expect(newMove.ease).toEqual(picked.ease)
    expect(newMove.play).toEqual(picked.play)
  })

  it('closing the gallery without picking leaves the move alone (no replace, no remove)', async () => {
    const clip: MotionClip = { moves: [CUSTOM_MOVE], duration: 4, fps: 30 }
    const w = mountPanel(clip)
    const changeBtn = w.findAll('button').find(b => b.text() === 'Change')
    await changeBtn!.trigger('click')
    expect(w.findComponent(MoveGallery).exists()).toBe(true)

    await w.findComponent(MoveGallery).vm.$emit('close')

    expect(w.findComponent(MoveGallery).exists()).toBe(false)
    expect(w.emitted('replace-move')).toBeFalsy()
    expect(w.emitted('remove-move')).toBeFalsy()
    expect(w.emitted('add-move')).toBeFalsy()
  })
})
