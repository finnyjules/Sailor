import { describe, it, expect } from 'vitest'
import { GALLERY_MOVES, movesForLayer, groupedMoves, type GalleryMove } from '~/lib/motionx/gallery'

describe('GALLERY_MOVES catalog', () => {
  it('every move has a stable id, a registered-kind, a group and a preview', () => {
    const ids = new Set<string>()
    for (const m of GALLERY_MOVES) {
      expect(m.id).toBeTruthy()
      expect(ids.has(m.id)).toBe(false)   // ids unique
      ids.add(m.id)
      expect([
        'fade', 'slide', 'scale', 'spin', 'pulse', 'sway', 'float', 'gradientScroll', 'gradientMorph', 'dither',
        'text.cascade', 'text.typewriter', 'text.maskSlide', 'text.scramble',
        'text.decode', 'text.slot', 'text.wave', 'text.bounce', 'text.jitter',
      ]).toContain(m.kind)
      expect(['Letters', 'In', 'Loop', 'Out', 'Gradient']).toContain(m.group)
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

describe('dither moves', () => {
  it('Dither in sits in the In group and Dither out in Out, for every layer', () => {
    const moves = movesForLayer({ gradient: false, text: false })
    const din = moves.find((m) => m.id === 'dither-in')!, dout = moves.find((m) => m.id === 'dither-out')!
    expect([din.kind, din.group, din.label, din.params]).toEqual(['dither', 'In', 'Dither in', { dir: 'in' }])
    expect([dout.kind, dout.group, dout.label, dout.params]).toEqual(['dither', 'Out', 'Dither out', { dir: 'out' }])
    expect(din.preview).toBe('dither'); expect(din.recipe).toBeUndefined()
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
  it('offers the ten Letters moves on a text layer', () => {
    const out = movesForLayer({ gradient: false, text: true })
    const letters = out.filter((m) => m.group === 'Letters')
    expect(letters).toHaveLength(10)
    expect(letters.every((m) => m.needs === 'text')).toBe(true)
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
  it('puts Letters first when present', () => {
    const moves: GalleryMove[] = [
      { id: 'a', kind: 'fade', label: 'A', group: 'In', preview: 'fade' },
      { id: 'c', kind: 'text.cascade', label: 'C', group: 'Letters', preview: 'letters-cascade', needs: 'text' },
    ]
    const g = groupedMoves(moves)
    expect(g.map((x) => x.group)).toEqual(['Letters', 'In'])
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
  it('Letters defaults to 1.2s', async () => {
    const { defaultDurationFor } = await import('~/lib/motionx/gallery')
    expect(defaultDurationFor('Letters')).toBe(1.2)
  })
})

describe('Letters moves', () => {
  it('are five text.* moves with the exact ids, kinds and params from the brief', () => {
    const byId = Object.fromEntries(GALLERY_MOVES.filter((m) => m.group === 'Letters').map((m) => [m.id, m]))
    expect(byId['letters-cascade-in']).toMatchObject({ kind: 'text.cascade', label: 'Cascade in', params: { dir: 'in', style: 'rise' } })
    expect(byId['letters-cascade-out']).toMatchObject({ kind: 'text.cascade', label: 'Cascade out', params: { dir: 'out', style: 'rise' } })
    expect(byId['letters-typewriter']).toMatchObject({ kind: 'text.typewriter', label: 'Typewriter', params: { dir: 'type' } })
    expect(byId['letters-mask']).toMatchObject({ kind: 'text.maskSlide', label: 'Mask slide', params: { dir: 'reveal', from: 'up' } })
    expect(byId['letters-scramble']).toMatchObject({ kind: 'text.scramble', label: 'Scramble', params: { mode: 'settle' }, cycle: 2 })
  })

  it('phase 2 adds five more text.* moves with the exact ids, kinds, params and cycles from the brief', () => {
    const byId = Object.fromEntries(GALLERY_MOVES.filter((m) => m.group === 'Letters').map((m) => [m.id, m]))
    expect(byId['letters-decode']).toMatchObject({ kind: 'text.decode', label: 'Decode', preview: 'letters-decode', needs: 'text', params: { dir: 'resolve' }, cycle: 1.5 })
    expect(byId['letters-slot']).toMatchObject({ kind: 'text.slot', label: 'Slot slide', preview: 'letters-slot', needs: 'text', params: { dir: 'in', roll: 'up' }, cycle: 1.6 })
    expect(byId['letters-wave']).toMatchObject({ kind: 'text.wave', label: 'Wave', preview: 'letters-wave', needs: 'text', cycle: 3 })
    expect(byId['letters-bounce']).toMatchObject({ kind: 'text.bounce', label: 'Bounce', preview: 'letters-bounce', needs: 'text', cycle: 3 })
    expect(byId['letters-jitter']).toMatchObject({ kind: 'text.jitter', label: 'Jitter', preview: 'letters-jitter', needs: 'text', cycle: 3 })
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

// Swapping a Letters bar for another move in place (the inspector's Behaviour menu).
describe('swapLetterMove', () => {
  const slot = { kind: 'text.slot', params: { dir: 'in', roll: 'down', steps: 11, filler: 'mixed', by: 'words', stagger: 0.04, order: 'centre', seed: 7, ease: [0.2, 0, 0, 1], hideBefore: false } }
  it('names the move a stored bar came from — cascade in and cascade out are different moves', async () => {
    const { letterMoveOf } = await import('~/lib/motionx/gallery')
    expect(letterMoveOf(slot)?.id).toBe('letters-slot')
    expect(letterMoveOf({ kind: 'text.cascade', params: { dir: 'out' } })?.id).toBe('letters-cascade-out')
    expect(letterMoveOf({ kind: 'text.cascade', params: {} })?.id).toBe('letters-cascade-in')
    expect(letterMoveOf({ kind: 'fade', params: {} })).toBeUndefined()
  })
  it('keeps what every Letters move shares and drops what belonged to the old one', async () => {
    const { swapLetterMove, GALLERY_MOVES } = await import('~/lib/motionx/gallery')
    const out = swapLetterMove(slot, GALLERY_MOVES.find((m) => m.id === 'letters-cascade-out')!)
    expect(out.kind).toBe('text.cascade')
    expect(out.params).toEqual({ dir: 'out', style: 'rise', by: 'words', stagger: 0.04, order: 'centre', seed: 7, ease: [0.2, 0, 0, 1], hideBefore: false })
  })
  it('never invents a shared param the bar did not have', async () => {
    const { swapLetterMove, GALLERY_MOVES } = await import('~/lib/motionx/gallery')
    const out = swapLetterMove({ kind: 'text.slot', params: { steps: 3 } }, GALLERY_MOVES.find((m) => m.id === 'letters-wave')!)
    expect(out).toEqual({ kind: 'text.wave', params: {} })
  })
  it('letterMoves lists exactly the Letters group', async () => {
    const { letterMoves } = await import('~/lib/motionx/gallery')
    expect(letterMoves().length).toBe(10)
    expect(letterMoves().every((m) => m.group === 'Letters' && m.kind.startsWith('text.'))).toBe(true)
  })
})
