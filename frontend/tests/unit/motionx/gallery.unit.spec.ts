import { describe, it, expect } from 'vitest'
import { GALLERY_MOVES, movesForLayer, groupedMoves, type GalleryMove } from '~/lib/motionx/gallery'

describe('GALLERY_MOVES catalog', () => {
  it('every move has a stable id, a registered-kind, a group and a preview', () => {
    const ids = new Set<string>()
    for (const m of GALLERY_MOVES) {
      expect(m.id).toBeTruthy()
      expect(ids.has(m.id)).toBe(false)   // ids unique
      ids.add(m.id)
      expect(['fade', 'slide', 'scale', 'spin', 'pulse', 'sway', 'float', 'gradientScroll', 'gradientMorph']).toContain(m.kind)
      expect(['In', 'Loop', 'Out', 'Gradient']).toContain(m.group)
      expect(m.preview).toBeTruthy()
    }
  })
  it('offers fade in/out and the four slide directions', () => {
    const slides = GALLERY_MOVES.filter((m) => m.kind === 'slide').map((m) => m.params?.dir)
    expect(new Set(slides)).toEqual(new Set(['up', 'down', 'left', 'right']))
    expect(GALLERY_MOVES.some((m) => m.kind === 'fade' && m.params?.dir === 'in')).toBe(true)
    expect(GALLERY_MOVES.some((m) => m.kind === 'fade' && m.params?.dir === 'out')).toBe(true)
  })
})

describe('movesForLayer', () => {
  it('hides gradient moves when the layer has no gradient fill', () => {
    const out = movesForLayer({ gradient: false, text: false })
    expect(out.some((m) => m.needs === 'gradient')).toBe(false)
    expect(out.some((m) => m.kind === 'fade')).toBe(true)   // transform/opacity always available
  })
  it('includes gradient moves when the fill is a gradient', () => {
    const out = movesForLayer({ gradient: true, text: false })
    expect(out.some((m) => m.needs === 'gradient')).toBe(true)
  })
  it('hides text-only moves on a non-text layer', () => {
    const out = movesForLayer({ gradient: true, text: false })
    expect(out.every((m) => m.needs !== 'text')).toBe(true)
  })
})

describe('groupedMoves', () => {
  it('buckets moves into In/Loop/Out/Gradient, dropping empty groups, in that order', () => {
    const moves: GalleryMove[] = [
      { id: 'a', kind: 'fade', label: 'A', group: 'In', preview: 'fade' },
      { id: 'b', kind: 'gradientScroll', label: 'B', group: 'Gradient', preview: 'scroll', needs: 'gradient' },
    ]
    const g = groupedMoves(moves)
    expect(g.map((x) => x.group)).toEqual(['In', 'Gradient'])
    expect(g[0]!.moves.map((m) => m.id)).toEqual(['a'])
  })
})

describe('recipes + placement defaults', () => {
  it('composite tiles expand to several single-property behaviours; simple tiles to one', async () => {
    const { behavioursForMove } = await import('~/lib/motionx/gallery')
    const slideUp = GALLERY_MOVES.find((m) => m.id === 'slide-up')!
    expect(behavioursForMove(slideUp).map((b) => b.kind)).toEqual(['slide', 'fade'])
    const fadeIn = GALLERY_MOVES.find((m) => m.id === 'fade-in')!
    expect(behavioursForMove(fadeIn)).toEqual([{ kind: 'fade', params: { dir: 'in' } }])
  })
  it('In/Out default to 0.8s; Loop/Gradient to one 2s cycle', async () => {
    const { defaultDurationFor } = await import('~/lib/motionx/gallery')
    expect(defaultDurationFor('In')).toBe(0.8)
    expect(defaultDurationFor('Out')).toBe(0.8)
    expect(defaultDurationFor('Loop')).toBe(2)
  })
})

describe('loop moves default to ONE cycle (the bar is a cycle; ghosts repeat it)', () => {
  it('each loop / gradient move has a finite cycle; in/out stay 0.8s', async () => {
    const { defaultDurationForMove } = await import('~/lib/motionx/gallery')
    for (const m of GALLERY_MOVES) {
      const d = defaultDurationForMove(m)
      expect(Number.isFinite(d) && d > 0).toBe(true)
      if (m.group === 'In' || m.group === 'Out') expect(d).toBe(0.8)
    }
    expect(defaultDurationForMove(GALLERY_MOVES.find((m) => m.id === 'spin')!)).toBe(2)
  })
})
