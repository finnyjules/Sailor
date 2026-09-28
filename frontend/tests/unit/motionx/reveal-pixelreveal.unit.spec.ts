import { describe, it, expect } from 'vitest'
import {
  PIXEL_REVEAL_LOOKS, PIXEL_REVEAL_PATTERNS, PIXEL_REVEAL_DIRECTIONS,
  pixelRevealParams, pickGrid, pieceOrder, pieceStates, lookTotal,
  revealWhen, levelAt, pixelRevealLookOf,
} from '~/lib/motionx/reveal/pixelReveal'

describe('PIXEL_REVEAL_LOOKS — the 9 gallery presets', () => {
  it('has exactly 9 looks with unique ids', () => {
    expect(PIXEL_REVEAL_LOOKS).toHaveLength(9)
    const ids = PIXEL_REVEAL_LOOKS.map((l) => l.id)
    expect(new Set(ids).size).toBe(9)
  })

  it('every look has a label and a blurb', () => {
    for (const look of PIXEL_REVEAL_LOOKS) {
      expect(look.label.length).toBeGreaterThan(0)
      expect(look.blurb.length).toBeGreaterThan(0)
    }
  })

  it('Signal: pixel 16, scanlines, right', () => {
    const signal = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'signal')!
    expect(signal.settings.pixel).toBe(16)
    expect(signal.settings.pattern).toBe('scanlines')
    expect(signal.settings.direction).toBe('right')
  })

  it('Typewriter splits into letters (chars)', () => {
    const typewriter = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'typewriter')!
    expect(typewriter.settings.split).toBe('chars')
  })

  it('Dissolve has no heat', () => {
    const dissolve = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'dissolve')!
    expect(dissolve.settings.heat.colours).toBeNull()
  })

  it('Bitmap has no heat', () => {
    const bitmap = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'bitmap')!
    expect(bitmap.settings.heat.colours).toBeNull()
  })

  it('Glitch carries two heat colours, mix .5', () => {
    const glitch = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'glitch')!
    expect(glitch.settings.heat.colours).toEqual(['#ff3d00', '#00d1ff'])
    expect(glitch.settings.heat.mix).toBeCloseTo(0.5, 9)
  })

  it('Materialize/Signal/Typewriter/Rain/Radiate/Flow use ultramarine', () => {
    for (const id of ['materialize', 'signal', 'typewriter', 'rain', 'radiate', 'flow']) {
      const look = PIXEL_REVEAL_LOOKS.find((l) => l.id === id)!
      expect(look.settings.heat.colours?.[0], id).toBe('#1700c7')
    }
  })

  it('pixelRevealLookOf falls back to the first look (materialize) for an unknown id', () => {
    expect(pixelRevealLookOf('nope').id).toBe('materialize')
    expect(pixelRevealLookOf(undefined).id).toBe('materialize')
    expect(pixelRevealLookOf(42).id).toBe('materialize')
  })

  it('every catalogue id round-trips through pixelRevealLookOf', () => {
    for (const look of PIXEL_REVEAL_LOOKS) expect(pixelRevealLookOf(look.id).id).toBe(look.id)
  })
})

describe('PIXEL_REVEAL_PATTERNS / PIXEL_REVEAL_DIRECTIONS — sentence-case labels', () => {
  it('patterns include Ordered dither for bayer', () => {
    const bayer = PIXEL_REVEAL_PATTERNS.find((p) => p.value === 'bayer')!
    expect(bayer.label).toBe('Ordered dither')
  })

  it('directions include Centre out for center', () => {
    const center = PIXEL_REVEAL_DIRECTIONS.find((d) => d.value === 'center')!
    expect(center.label).toBe('Centre out')
  })

  it('no label is empty, all-caps, or contains an identifier-looking token', () => {
    for (const { label } of [...PIXEL_REVEAL_PATTERNS, ...PIXEL_REVEAL_DIRECTIONS]) {
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toMatch(/_/)
    }
  })
})

describe('pixelRevealParams — the ONE reader', () => {
  it('defaults to the first look (materialize), dir in', () => {
    const p = pixelRevealParams(undefined)
    expect(p.look.id).toBe('materialize')
    expect(p.out).toBe(false)
    expect(p.pieces).toBe('words')
    expect(p.pattern).toBe('clusters')
    expect(p.direction).toBe('up')
    expect(p.pixel).toBe(24)
    expect(p.levels).toBe(3)
    expect(p.spread).toBeCloseTo(0.8, 9)
    expect(p.heat.colours).toEqual(['#1700c7'])
  })

  it('dir out', () => {
    expect(pixelRevealParams({ dir: 'out' }).out).toBe(true)
  })

  it('an unknown look id falls back to materialize', () => {
    expect(pixelRevealParams({ look: 'nope' }).look.id).toBe('materialize')
  })

  it('every look round-trips and carries its own numbers when nothing else is stored', () => {
    for (const look of PIXEL_REVEAL_LOOKS) {
      const p = pixelRevealParams({ look: look.id })
      expect(p.pixel).toBe(look.settings.pixel)
      expect(p.levels).toBe(look.settings.levels)
      expect(p.pattern).toBe(look.settings.pattern)
      expect(p.direction).toBe(look.settings.direction)
    }
  })

  it('pixel clamps to [4, 64]', () => {
    expect(pixelRevealParams({ pixel: -5 }).pixel).toBe(4)
    expect(pixelRevealParams({ pixel: 1000 }).pixel).toBe(64)
    expect(pixelRevealParams({ pixel: 40 }).pixel).toBe(40)
    expect(pixelRevealParams({ pixel: NaN }).pixel).toBe(24)
    expect(pixelRevealParams({ pixel: '40' }).pixel).toBe(24)
  })

  it('levels clamps to [0, 5] and rounds', () => {
    expect(pixelRevealParams({ levels: -1 }).levels).toBe(0)
    expect(pixelRevealParams({ levels: 9 }).levels).toBe(5)
    expect(pixelRevealParams({ levels: 2.6 }).levels).toBe(3)
  })

  it('spread clamps to [0.05, 1]', () => {
    expect(pixelRevealParams({ spread: 0 }).spread).toBeCloseTo(0.05, 9)
    expect(pixelRevealParams({ spread: 5 }).spread).toBe(1)
    expect(pixelRevealParams({ spread: 0.3 }).spread).toBeCloseTo(0.3, 9)
  })

  it('pieces overrides the look default; an unknown value falls back to the look default', () => {
    expect(pixelRevealParams({ pieces: 'lines' }).pieces).toBe('lines')
    expect(pixelRevealParams({ pieces: 'nonsense' }).pieces).toBe('words')
    expect(pixelRevealParams({ look: 'typewriter' }).pieces).toBe('letters')
    expect(pixelRevealParams({ look: 'dissolve' }).pieces).toBe('lines')
  })

  it('pattern/direction override the look default; an unknown value falls back', () => {
    expect(pixelRevealParams({ pattern: 'flow' }).pattern).toBe('flow')
    expect(pixelRevealParams({ pattern: 'nonsense' }).pattern).toBe('clusters')
    expect(pixelRevealParams({ direction: 'down' }).direction).toBe('down')
    expect(pixelRevealParams({ direction: 'nonsense' }).direction).toBe('up')
  })

  it('heat: absent keeps the look colours, null clears them, a hex overrides the first colour', () => {
    const absent = pixelRevealParams({})
    expect(absent.heat.colours).toEqual(['#1700c7'])

    const cleared = pixelRevealParams({ heat: null })
    expect(cleared.heat.colours).toBeNull()

    const overridden = pixelRevealParams({ heat: '#00ff00' })
    expect(overridden.heat.colours).toEqual(['#00ff00'])

    const glitchOverridden = pixelRevealParams({ look: 'glitch', heat: '#00ff00' })
    expect(glitchOverridden.heat.colours).toEqual(['#00ff00', '#00d1ff'])
  })

  it('heat: an invalid hex falls back to the look colours', () => {
    expect(pixelRevealParams({ heat: 'red' }).heat.colours).toEqual(['#1700c7'])
    expect(pixelRevealParams({ heat: '#fff' }).heat.colours).toEqual(['#1700c7'])
    expect(pixelRevealParams({ heat: '#gggggg' }).heat.colours).toEqual(['#1700c7'])
    expect(pixelRevealParams({ heat: 123 }).heat.colours).toEqual(['#1700c7'])
  })

  it('carries the look timing through untouched when nothing overrides it', () => {
    const p = pixelRevealParams({ look: 'rain' })
    const rain = PIXEL_REVEAL_LOOKS.find((l) => l.id === 'rain')!
    expect(p.stagger).toBe(rain.settings.stagger)
    expect(p.duration).toBe(rain.settings.duration)
    expect(p.rise).toBe(rain.settings.rise)
    expect(p.from).toBe(rain.settings.from)
  })
})

describe('pickGrid', () => {
  it('24 device px picks (m=3, k=3)', () => {
    const g = pickGrid(24, 5)
    expect(g.m).toBe(3)
    expect(g.k).toBe(3)
    expect(g.s).toBe(24)
  })

  it('16 device px picks (m=1, k=4)', () => {
    const g = pickGrid(16, 5)
    expect(g.m).toBe(1)
    expect(g.k).toBe(4)
    expect(g.s).toBe(16)
  })

  it('caps levels at k (m=1) or k+1 (m=3)', () => {
    const g24 = pickGrid(24, 99)
    expect(g24.levels).toBe(g24.k + 1)
    const g16 = pickGrid(16, 99)
    expect(g16.levels).toBe(g16.k)
  })

  it('never returns a level cap above the requested levels', () => {
    const g = pickGrid(24, 2)
    expect(g.levels).toBe(2)
  })

  it('never picks a block smaller than 2', () => {
    const g = pickGrid(1, 3)
    expect(g.s).toBeGreaterThanOrEqual(2)
  })
})

describe('pieceOrder', () => {
  const n = 6

  it('start: identity', () => {
    expect(pieceOrder(n, 'start')).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('end: reversed', () => {
    expect(pieceOrder(n, 'end')).toEqual([5, 4, 3, 2, 1, 0])
  })

  it('center: the middle pieces rank first', () => {
    const order = pieceOrder(n, 'center')
    // pieces 2 and 3 are closest to the centre (n-1)/2 = 2.5
    expect(Math.min(order[2], order[3])).toBe(0)
  })

  it('edges: the opposite ranking of center', () => {
    const order = pieceOrder(n, 'edges')
    // pieces 2 and 3 (closest to centre) rank LAST under edges
    expect(Math.max(order[2], order[3])).toBe(n - 1)
  })

  it('random: a permutation of 0..n-1, deterministic for a fixed seed', () => {
    const a = pieceOrder(n, 'random', 7)
    const b = pieceOrder(n, 'random', 7)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('random: a different seed can produce a different order', () => {
    const a = pieceOrder(n, 'random', 7)
    const c = pieceOrder(n, 'random', 99)
    expect(a).not.toEqual(c)
  })

  it('every from value returns a full permutation of 0..n-1', () => {
    for (const from of ['start', 'end', 'center', 'edges', 'random'] as const) {
      const order = pieceOrder(n, from)
      expect([...order].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5])
    }
  })
})

describe('lookTotal', () => {
  it('is at least 0.05s', () => {
    const p = pixelRevealParams({ look: 'typewriter' })
    expect(lookTotal(p, 1)).toBeGreaterThanOrEqual(0.05)
  })

  it('grows with piece count when sweep is "each"', () => {
    const p = pixelRevealParams({ look: 'materialize' })
    expect(lookTotal(p, 10)).toBeGreaterThan(lookTotal(p, 1))
  })
})

describe('pieceStates', () => {
  it('all progress 0 at amount 0', () => {
    const p = pixelRevealParams({ look: 'materialize' })
    const states = pieceStates(p, 5, 0)
    expect(states).toHaveLength(5)
    for (const s of states) expect(s.progress).toBe(0)
  })

  it('all progress 1 and riseFrac 0 at amount 1', () => {
    const p = pixelRevealParams({ look: 'materialize' })
    const states = pieceStates(p, 5, 1)
    for (const s of states) {
      expect(s.progress).toBeCloseTo(1, 6)
      expect(s.riseFrac).toBeCloseTo(0, 6)
    }
  })

  it('a rising look (rise !== 0) starts fully offset: riseFrac 1 at amount 0', () => {
    const p = pixelRevealParams({ look: 'materialize' }) // rise .45
    const states = pieceStates(p, 3, 0)
    for (const s of states) expect(s.riseFrac).toBeCloseTo(1, 6)
  })

  it('a non-rising look (rise 0) has riseFrac 0 throughout', () => {
    const p = pixelRevealParams({ look: 'signal' }) // rise 0
    for (const amount of [0, 0.3, 0.6, 1]) {
      const states = pieceStates(p, 4, amount)
      for (const s of states) expect(s.riseFrac).toBeCloseTo(0, 6)
    }
  })

  it('progress is monotone non-decreasing in amount, per piece', () => {
    const p = pixelRevealParams({ look: 'rain' })
    const n = 6
    const samples = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1].map((a) => pieceStates(p, n, a))
    for (let i = 0; i < n; i++) {
      for (let k = 1; k < samples.length; k++) {
        expect(samples[k][i].progress).toBeGreaterThanOrEqual(samples[k - 1][i].progress - 1e-9)
      }
    }
  })

  it('under from:start with stagger > 0, a later piece is never ahead of an earlier one', () => {
    const p = pixelRevealParams({ look: 'materialize' }) // from: start, stagger .06
    expect(p.from).toBe('start')
    expect(p.stagger).toBeGreaterThan(0)
    const n = 6
    for (const amount of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
      const states = pieceStates(p, n, amount)
      for (let i = 1; i < n; i++) {
        expect(states[i].progress).toBeLessThanOrEqual(states[i - 1].progress + 1e-9)
      }
    }
  })

  it('sweep "whole" looks share one progress across every piece at a given amount', () => {
    const p = pixelRevealParams({ look: 'dissolve' }) // sweep: whole
    expect(p.sweep).toBe('whole')
    const states = pieceStates(p, 5, 0.4)
    const first = states[0].progress
    for (const s of states) expect(s.progress).toBeCloseTo(first, 9)
  })

  it('returns exactly n states for n pieces', () => {
    const p = pixelRevealParams({ look: 'flow' })
    expect(pieceStates(p, 1, 0.5)).toHaveLength(1)
    expect(pieceStates(p, 9, 0.5)).toHaveLength(9)
  })
})

describe('revealWhen — CPU mirror of the shader\'s when-field', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 }

  it('stays within [0, 1]', () => {
    for (let cx = 0; cx < 5; cx++) {
      for (let cy = 0; cy < 5; cy++) {
        const v = revealWhen({ x: cx, y: cy }, {
          at: { x: cx * 8 + 4, y: cy * 8 + 4 }, rect,
          pattern: 'clusters', direction: 'up', noise: 0.5, scatter: 0.08,
        })
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('direction "up" reveals the bottom first (when = 1 − ny), before scatter', () => {
    const top = revealWhen({ x: 1, y: 0 }, {
      at: { x: 10, y: 1 }, rect, pattern: 'none', direction: 'up', noise: 0, scatter: 0,
    })
    const bottom = revealWhen({ x: 1, y: 12 }, {
      at: { x: 10, y: 99 }, rect, pattern: 'none', direction: 'up', noise: 0, scatter: 0,
    })
    expect(bottom).toBeLessThan(top)
  })

  it('is deterministic for the same inputs', () => {
    const opts = { at: { x: 3, y: 3 }, rect, pattern: 'random' as const, direction: 'none' as const, noise: 1, scatter: 0.2 }
    const a = revealWhen({ x: 1, y: 1 }, opts)
    const b = revealWhen({ x: 1, y: 1 }, opts)
    expect(a).toBe(b)
  })
})

describe('levelAt — CPU mirror of the level thresholds', () => {
  it('is 0 when life is 0', () => {
    expect(levelAt(0, { x: 2, y: 3 }, 5)).toBe(0)
  })

  it('never exceeds the requested levels', () => {
    for (const levels of [0, 1, 2, 3, 4, 5]) {
      const lvl = levelAt(1, { x: 2, y: 3 }, Math.max(levels, 1))
      expect(lvl).toBeLessThanOrEqual(Math.max(levels, 1))
    }
  })

  it('is monotone non-decreasing in life for a fixed block', () => {
    const blk = { x: 4, y: 7 }
    let prev = -1
    for (let life = 0; life <= 1; life += 0.05) {
      const lvl = levelAt(life, blk, 5)
      expect(lvl).toBeGreaterThanOrEqual(prev)
      prev = lvl
    }
  })

  it('reaches the full level count at life 1 with levels = 1', () => {
    expect(levelAt(1, { x: 0, y: 0 }, 1)).toBe(1)
  })
})
