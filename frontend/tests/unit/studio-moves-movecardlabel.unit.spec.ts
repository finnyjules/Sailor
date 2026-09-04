// frontend/tests/unit/studio-moves-movecardlabel.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { lastPathSegment, moveCardLabel } from '~/components/vue-canvas/motion/moves/moveCardLabel'
import type { MovesAdapter } from '~/lib/studio/moves/adapter'
import type { Move } from '~/lib/studio/moves/types'

const EASE = { kind: 'named', name: 'smooth' } as const
const PLAY = { mode: 'once', times: 1 } as const

function baseMove(partial: Partial<Move>): Move {
  return { id: 'm1', phase: 'loop', kind: 'tracks', duration: 1, ease: EASE, play: PLAY, ...partial }
}

const ADAPTER: MovesAdapter<unknown> = {
  kinds: { preset: { label: 'Preset' }, blink: { label: 'Blink' }, unlabeled: {} },
  gallery: () => [],
  animatable: () => [],
  availability: () => null,
}

describe('lastPathSegment', () => {
  it('returns the final dotted segment', () => {
    expect(lastPathSegment('motion.blink.amount')).toBe('amount')
  })
  it('returns the whole string when there is no dot', () => {
    expect(lastPathSegment('amount')).toBe('amount')
  })
})

describe('moveCardLabel', () => {
  it('labels a custom tracks move by its first track\'s last path segment', () => {
    const move = baseMove({ kind: 'tracks', presetId: 'custom', tracks: [{ path: 'appearance.layer1.weight', from: 0, to: 1 }] })
    expect(moveCardLabel(move, ADAPTER)).toBe('Custom · weight')
  })

  it('treats a tracks move with no presetId the same as "custom"', () => {
    const move = baseMove({ kind: 'tracks', tracks: [{ path: 'motion.slant', from: 0, to: 1 }] })
    expect(moveCardLabel(move, ADAPTER)).toBe('Custom · slant')
  })

  it('falls back to "Custom" for a custom tracks move with no tracks', () => {
    const move = baseMove({ kind: 'tracks', presetId: 'custom', tracks: [] })
    expect(moveCardLabel(move, ADAPTER)).toBe('Custom')
  })

  it('labels a tracks move built from a named preset by the preset id (no kinds entry for "tracks")', () => {
    const move = baseMove({ kind: 'tracks', presetId: 'stretch-in', tracks: [{ path: 'x', from: 0, to: 1 }] })
    expect(moveCardLabel(move, ADAPTER)).toBe('stretch-in')
  })

  it('uses adapter.kinds[kind].label when present', () => {
    const move = baseMove({ kind: 'blink', presetId: undefined })
    expect(moveCardLabel(move, ADAPTER)).toBe('Blink')
  })

  it('falls back to presetId when the kind has no label', () => {
    const move = baseMove({ kind: 'unlabeled', presetId: 'my-preset' })
    expect(moveCardLabel(move, ADAPTER)).toBe('my-preset')
  })

  it('falls back to the kind string when there is neither a label nor a presetId', () => {
    const move = baseMove({ kind: 'mystery' })
    expect(moveCardLabel(move, ADAPTER)).toBe('mystery')
  })

  it('prefers adapter.moveLabel over the generic kind label (preset name beats "Preset")', () => {
    const withNames: MovesAdapter<unknown> = {
      ...ADAPTER,
      moveLabel: (m) => (m.presetId === 'wave' ? 'Wave' : undefined),
    }
    const wave = baseMove({ kind: 'preset', presetId: 'wave' })
    expect(moveCardLabel(wave, withNames)).toBe('Wave')
  })

  it('defers to the generic chain when moveLabel returns undefined', () => {
    const withNames: MovesAdapter<unknown> = { ...ADAPTER, moveLabel: () => undefined }
    const blink = baseMove({ kind: 'blink', presetId: undefined })
    expect(moveCardLabel(blink, withNames)).toBe('Blink')
  })
})
