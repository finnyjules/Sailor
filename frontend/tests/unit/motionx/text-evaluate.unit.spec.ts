import { describe, it, expect } from 'vitest'
import { evaluateTextBehaviours, isTextBehaviour } from '~/lib/motionx/text'
import type { TextCell } from '~/lib/motionx/text/units'

const cell = (char: string, x: number, word = 0, line = 0, angle = 0): TextCell => ({ char, x, y: 0, w: 10, h: 20, angle, word, line })
const CELLS = [cell('A', -15), cell('B', -5), cell('C', 5, 1), cell('D', 15, 1)]
const FRAME = { w: 1000, h: 500 }
const beh = (kind: string, params: Record<string, unknown> = {}, start = 1, duration = 1) =>
  ({ id: 'b', layerId: 'L', kind, params: { ease: 'linear', stagger: 0, ...params }, timing: { start, duration } }) as any
const ev = (b: any | any[], t: number, cells = CELLS) => evaluateTextBehaviours(Array.isArray(b) ? b : [b], t, cells, FRAME)

describe('basics', () => {
  it('isTextBehaviour', () => { expect(isTextBehaviour({ kind: 'text.cascade' })).toBe(true); expect(isTextBehaviour({ kind: 'fade' })).toBe(false) })
  it('no text behaviours, or no cells → at rest', () => {
    expect(ev([], 1).atRest).toBe(true)
    expect(ev({ ...beh('fade') }, 1).atRest).toBe(true)
    expect(evaluateTextBehaviours([beh('text.cascade')], 1.5, [], FRAME)).toEqual({ atRest: true, cells: [] })
  })
  it('an unknown text.* kind is ignored', () => { expect(ev(beh('text.nope'), 1.5).atRest).toBe(true) })
})

describe('text.cascade', () => {
  it('in: hidden before the bar, exactly at rest after it', () => {
    const before = ev(beh('text.cascade', { style: 'fade' }), 0.5)
    expect(before.atRest).toBe(false)
    expect(before.cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(beh('text.cascade', { style: 'fade' }), 2.5).atRest).toBe(true)
  })
  it('rise: half way, each letter sits half the amount BELOW its place and is half visible', () => {
    const f = ev(beh('text.cascade', { style: 'rise', amount: 1 }), 1.5)
    expect(f.cells[0]).toMatchObject({ x: -15, opacity: 0.5 })
    expect(f.cells[0]!.y).toBeCloseTo(10, 6)            // 0.5 × amount 1 × piece height 20
  })
  it('out mirrors in: at rest before, hidden after', () => {
    expect(ev(beh('text.cascade', { dir: 'out', style: 'fade' }), 0.5).atRest).toBe(true)
    expect(ev(beh('text.cascade', { dir: 'out', style: 'fade' }), 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })
  it('stagger + order: with rtl the LAST letter leads', () => {
    const f = ev(beh('text.cascade', { style: 'fade', stagger: 0.2, order: 'rtl' }), 1.1)   // pieceDur 0.4
    expect(f.cells[3]!.opacity).toBeCloseTo(0.25, 6)
    expect(f.cells[0]!.opacity).toBe(0)
  })
  it('by words: a word grows about ITS centre, letters keep their spacing ratio', () => {
    const f = ev(beh('text.cascade', { style: 'grow', amount: 0, by: 'words' }), 1.5)     // scale 0.5
    expect(f.cells[0]!.scale).toBeCloseTo(0.5, 6)
    expect(f.cells[0]!.x).toBeCloseTo(-12.5, 6)        // word centre −10; −15 → −10 + (−5 × 0.5)
    expect(f.cells[1]!.x).toBeCloseTo(-7.5, 6)
  })
  it('spin rotates; on path text "rise" moves along the glyph\'s own normal', () => {
    expect(ev(beh('text.cascade', { style: 'spin', amount: 90 }), 1.5).cells[0]!.rotation).toBeCloseTo(-Math.PI / 4, 6)
    const tilted = [cell('A', 0, 0, 0, Math.PI / 2)]
    const f = ev(beh('text.cascade', { style: 'rise', amount: 1 }), 1.5, tilted)
    expect(f.cells[0]!.x).toBeCloseTo(-10, 6)          // local +y (10px) rotated by 90° → −x
    expect(f.cells[0]!.y).toBeCloseTo(0, 6)
    expect(f.cells[0]!.rotation).toBeCloseTo(Math.PI / 2, 6)
  })
  it('a spring ease overshoots past its place on the way in', () => {
    const b = beh('text.cascade', { style: 'rise', amount: 1, ease: { type: 'spring', bounce: 0.6 } })
    const ys = [1.3, 1.4, 1.5, 1.6, 1.8].map((t) => ev(b, t).cells[0]!.y)
    expect(Math.min(...ys)).toBeLessThan(0)            // went ABOVE rest (y < 0) before settling
  })
})

describe('text.typewriter', () => {
  it('hard cuts in reading order; the cursor sits after the last visible letter', () => {
    const b = beh('text.typewriter', { stagger: 0.25, cursor: 'bar', blink: 0 })
    const f = ev(b, 1.3)                               // letters 0 and 1 started (delays 0, .25)
    expect(f.cells.map((c) => c.opacity)).toEqual([1, 1, 0, 0])
    expect(f.cursor).toMatchObject({ x: 0, y: 0, h: 20, style: 'bar' })   // right edge of 'B' (−5 + 5)
  })
  it('delete removes from the end; no cursor when cursor is none', () => {
    const f = ev(beh('text.typewriter', { dir: 'delete', stagger: 0.25, cursor: 'none' }), 1.3)
    expect(f.cells.map((c) => c.opacity)).toEqual([1, 1, 0, 0])
    expect(f.cursor).toBeUndefined()
  })
  it('blink hides the cursor for half of each blink period', () => {
    const b = beh('text.typewriter', { stagger: 0.25, cursor: 'bar', blink: 1 })
    expect(ev(b, 1.1).cursor).toBeDefined()
    expect(ev(b, 1.6).cursor).toBeUndefined()
  })
})

describe('text.maskSlide', () => {
  it('reveal from up: the letter starts one height BELOW and is clipped to its own resting box', () => {
    const f = ev(beh('text.maskSlide', { from: 'up' }), 1.25)
    expect(f.cells[0]!.y).toBeCloseTo(15, 6)           // (1 − 0.25) × 20
    expect(f.cells[0]!.opacity).toBe(1)
    expect(f.cells[0]!.clip).toEqual({ x: -15, y: 0, w: 10, h: 20, angle: 0 })
  })
  it('from left travels along x by the piece width; hide is the mirror', () => {
    expect(ev(beh('text.maskSlide', { from: 'left' }), 1.5).cells[0]!.x).toBeCloseTo(-15 + 5, 6)
    const hide = ev(beh('text.maskSlide', { dir: 'hide', from: 'up' }), 1.75)
    expect(hide.cells[0]!.y).toBeCloseTo(15, 6)
  })
})

describe('text.scramble', () => {
  const S = (params: Record<string, unknown> = {}) => beh('text.scramble', { areaW: 0.5, areaH: 0.5, interval: 0.2, ...params }, 1, 2)
  it('settle: hidden before, jumping inside the area during, EXACTLY at rest after', () => {
    expect(ev(S(), 0.5).cells.every((c) => c.opacity === 0)).toBe(true)
    const mid = ev(S(), 1.5)
    for (const c of mid.cells) { expect(Math.abs(c.x)).toBeLessThanOrEqual(250); expect(Math.abs(c.y)).toBeLessThanOrEqual(125); expect(c.opacity).toBe(1) }
    expect(mid.cells.some((c, i) => Math.abs(c.x - CELLS[i]!.x) > 1)).toBe(true)
    expect(ev(S(), 3.5).atRest).toBe(true)
  })
  it('snap holds a spot for a whole interval, then cuts to the next', () => {
    const a = ev(S(), 1.01).cells[0]!, b = ev(S(), 1.19).cells[0]!, c = ev(S(), 1.21).cells[0]!
    expect([a.x, a.y]).toEqual([b.x, b.y])
    expect([c.x, c.y]).not.toEqual([a.x, a.y])
  })
  it('glide moves continuously and lands exactly on the rest position', () => {
    const g = S({ move: 'glide' })
    const a = ev(g, 1.05).cells[0]!, b = ev(g, 1.10).cells[0]!
    expect([a.x, a.y]).not.toEqual([b.x, b.y])
    const end = ev(g, 2.9999).cells[0]!              // last hop targets rest; 0.05% of a ≤250px hop left
    expect(end.x).toBeCloseTo(CELLS[0]!.x, 0); expect(end.y).toBeCloseTo(0, 0)
  })
  it('same seed same picture; another seed another picture', () => {
    expect(ev(S({ seed: 3 }), 1.5)).toEqual(ev(S({ seed: 3 }), 1.5))
    expect(ev(S({ seed: 4 }), 1.5)).not.toEqual(ev(S({ seed: 3 }), 1.5))
  })
  it('scatter: at rest before, gone after; loop: at rest outside the bar', () => {
    expect(ev(S({ mode: 'scatter' }), 0.5).atRest).toBe(true)
    expect(ev(S({ mode: 'scatter' }), 3.5).cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(S({ mode: 'loop' }), 0.5).atRest).toBe(true)
    expect(ev(S({ mode: 'loop' }), 3.5).atRest).toBe(true)
    expect(ev(S({ mode: 'loop' }), 2).atRest).toBe(false)
  })
  it('by words: the letters of a word travel together', () => {
    const f = ev(S({ by: 'words' }), 1.5)
    expect(f.cells[1]!.x - f.cells[0]!.x).toBeCloseTo(10, 6)
    expect(f.cells[1]!.y).toBeCloseTo(f.cells[0]!.y, 6)
  })
  it('spin gives each jump a rotation within ±spin', () => {
    const f = ev(S({ spin: 90 }), 1.5)
    expect(f.cells.some((c) => Math.abs(c.rotation) > 0.01)).toBe(true)
    for (const c of f.cells) expect(Math.abs(c.rotation)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9)
  })
})

describe('composition', () => {
  it('two behaviours combine: offsets add, opacities multiply', () => {
    const a = beh('text.cascade', { style: 'rise', amount: 1 }), b = beh('text.cascade', { style: 'fade' })
    const f = ev([a, { ...b, id: 'b2' }], 1.5)
    expect(f.cells[0]!.y).toBeCloseTo(10, 6)
    expect(f.cells[0]!.opacity).toBeCloseTo(0.25, 6)
  })
})
