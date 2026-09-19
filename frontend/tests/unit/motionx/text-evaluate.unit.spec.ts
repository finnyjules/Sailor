import { describe, it, expect } from 'vitest'
import { evaluateTextBehaviours, isTextBehaviour, textCanMove } from '~/lib/motionx/text'
import { springSettle } from '~/lib/motionx/ease'
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
  it('a spring entrance reaches rest once the spring settles, not merely once p passes 1', () => {
    const b = beh('text.cascade', { style: 'rise', amount: 1, ease: { type: 'spring', bounce: 0.6 } })
    expect(ev(b, 2.2).atRest).toBe(false)                          // still settling
    expect(ev(b, 1 + springSettle(0.6) + 0.01).atRest).toBe(true)  // just past settle
    expect(ev(b, 60).atRest).toBe(true)                            // long after
  })
  it('a staggered spring entrance reaches rest once every piece has settled', () => {
    const b = beh('text.cascade', { style: 'rise', amount: 1, stagger: 0.2, ease: { type: 'spring', bounce: 0.6 } })
    expect(ev(b, 2.2).atRest).toBe(false)      // the last piece is still settling
    expect(ev(b, 60).atRest).toBe(true)        // well after every piece's own settle time
  })
  it('an exit with a spring ease still ends exactly HIDDEN at the bar end (progress is clamped 0..1 for exits)', () => {
    const b = beh('text.cascade', { dir: 'out', style: 'fade', ease: { type: 'spring', bounce: 0.6 } })
    expect(ev(b, 2).cells.every((c) => c.opacity === 0)).toBe(true)    // bar end: start(1) + duration(1)
    expect(ev(b, 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
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

// SETTLE MEANS LANDING, NOT ARRIVING. "Pieces jump around, then land in place; Order and
// Stagger decide which pieces LAND first." A staggered settle that kept each piece hidden until
// its own turn would materialise a long word left to right like a cascade — and would not be
// the mirror of Scatter, where every piece is visible from the bar's start and leaves on its
// own turn. So the whole word hops from the bar's first frame, and the stagger says only when
// each piece stops.
describe('text.scramble settle hops from the bar\'s first frame, whatever the stagger', () => {
  // 4 letters, stagger 0.2 over a 2s bar: delays 0 / .2 / .4 / .6, pieceDur 1.4.
  const S = (params: Record<string, unknown> = {}) =>
    beh('text.scramble', { areaW: 0.5, areaH: 0.5, interval: 0.2, stagger: 0.2, ...params }, 1, 2)
  const landed = (f: ReturnType<typeof ev>, i: number) =>
    f.cells[i]!.x === CELLS[i]!.x && f.cells[i]!.y === CELLS[i]!.y && f.cells[i]!.rotation === 0

  it('every piece is visible and already displaced on the bar\'s first frame', () => {
    const f = ev(S(), 1.01)
    expect(f.cells.map((c) => c.opacity)).toEqual([1, 1, 1, 1])
    f.cells.forEach((c, i) => {
      expect(Math.abs(c.x - CELLS[i]!.x) + Math.abs(c.y), `cell ${i} sat still`).toBeGreaterThan(1)
    })
  })

  it('the pieces LAND in rank order, the last one with the bar', () => {
    const early = ev(S(), 2.5)                  // barElapsed 1.5: piece 0 landed at 1.4
    expect(landed(early, 0)).toBe(true)
    expect(landed(early, 3)).toBe(false)        // its own landing is at 2.0
    expect(early.atRest).toBe(false)
    const rtl = ev(S({ order: 'rtl' }), 2.5)     // the order decides WHICH lands first
    expect(landed(rtl, 3)).toBe(true)
    expect(landed(rtl, 0)).toBe(false)
  })

  it('hidden before the bar, exactly at rest after it', () => {
    expect(ev(S(), 0.5).cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(S(), 3.01).atRest).toBe(true)
    ev(S(), 3.01).cells.forEach((c, i) => expect(landed(ev(S(), 3.01), i)).toBe(true))
  })

  it('scatter is its mirror: every piece visible until the bar ends, then all gone at once', () => {
    const out = S({ mode: 'scatter' })
    expect(ev(out, 1.01).cells.every((c) => c.opacity === 1)).toBe(true)
    const late = ev(out, 2.95)                  // piece 0 spent its own progress at 2.4
    expect(late.cells.every((c) => c.opacity === 1)).toBe(true)
    expect(ev(out, 3.01).cells.every((c) => c.opacity === 0)).toBe(true)
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

// A mask slide's clip is the WINDOW the letter slides through. Anything else on the same
// layer moves the letter AND its window together — otherwise the glyph is drawn in one place
// and clipped to a box left behind somewhere else, and nothing paints at all.
describe('a mask slide composed with another bar keeps its window on the glyph', () => {
  const mask = { ...beh('text.maskSlide', { dir: 'reveal', from: 'up' }, 1, 2), id: 'm' }
  const scramble = { ...beh('text.scramble', { mode: 'settle', areaW: 0.5, areaH: 0.5, interval: 0.2 }, 1, 2), id: 's' }
  const rise = { ...beh('text.cascade', { style: 'rise', amount: 3 }, 1, 2), id: 'c' }
  const MID = 2   // both bars run 1 → 3

  /** Every visible cell sits inside its OWN clip box, grown by one cell height all round. */
  const insideItsOwnClip = (f: ReturnType<typeof ev>) => {
    let seen = 0
    f.cells.forEach((c, i) => {
      if (c.opacity <= 0) return
      seen++
      const clip = c.clip
      expect(clip, `cell ${i} lost its clip`).toBeDefined()
      const ox = c.x - clip!.x, oy = c.y - clip!.y
      const cos = Math.cos(-clip!.angle), sin = Math.sin(-clip!.angle)
      const lx = ox * cos - oy * sin, ly = ox * sin + oy * cos
      const h = CELLS[0]!.h
      expect(Math.abs(lx), `cell ${i} drawn outside its clip in x`).toBeLessThanOrEqual(clip!.w / 2 + h)
      expect(Math.abs(ly), `cell ${i} drawn outside its clip in y`).toBeLessThanOrEqual(clip!.h / 2 + h)
    })
    expect(seen).toBeGreaterThan(0)
  }

  it('mask slide + scramble: the window travels with the letter, in either order', () => {
    insideItsOwnClip(ev([mask, scramble], MID))
    insideItsOwnClip(ev([scramble, mask], MID))
  })
  it('mask slide + scramble: the two orders draw the same frame', () => {
    expect(ev([mask, scramble], MID)).toEqual(ev([scramble, mask], MID))
  })
  it('mask slide + cascade rise: the window travels with the letter, in either order', () => {
    insideItsOwnClip(ev([mask, rise], MID))
    insideItsOwnClip(ev([rise, mask], MID))
  })
  it('mask slide + cascade rise: the two orders draw the same frame', () => {
    expect(ev([mask, rise], MID)).toEqual(ev([rise, mask], MID))
  })
})

// A spring keeps moving past the end of its segment, which is what lets a cascade or a mask
// slide overshoot and settle. A kind that does not INTERPOLATE towards rest — scramble hops to
// a hashed spot, typewriter hard-cuts — has nothing to settle into, so for it a spring is just
// another curve: the bar's edges still mean REST / HIDDEN exactly.
describe('the spring tail is opt-in per behaviour kind', () => {
  const SPRING = { type: 'spring', bounce: 0.4 } as const
  const atRestCell = (i: number) => ({ x: CELLS[i]!.x, y: CELLS[i]!.y, rotation: CELLS[i]!.angle, scale: 1, opacity: 1 })

  it('scramble settle with a spring ease has landed by the end of its bar', () => {
    const f = ev(beh('text.scramble', { mode: 'settle', areaW: 0.5, areaH: 0.5, interval: 0.2, ease: SPRING }, 1, 2), 3.01)
    expect(f.atRest).toBe(true)
    f.cells.forEach((c, i) => expect(c).toEqual(atRestCell(i)))
  })

  it('typewriter with a spring ease behaves exactly as with a linear one', () => {
    const tw = (ease: unknown) => beh('text.typewriter', { stagger: 0.25, cursor: 'bar', blink: 0, ease })
    for (const t of [0.5, 1.1, 1.3, 1.6, 2, 2.01, 2.5, 3]) {
      expect(ev(tw(SPRING), t), `at t=${t}`).toEqual(ev(tw('linear'), t))
    }
  })

  it('cascade and mask slide KEEP their tail (the overshoot is the point)', () => {
    expect(ev(beh('text.cascade', { style: 'rise', amount: 1, ease: SPRING }), 2.01).atRest).toBe(false)
    expect(ev(beh('text.maskSlide', { from: 'up', ease: SPRING }), 2.01).atRest).toBe(false)
  })
})

describe('unknown enum values fall back to their documented default', () => {
  const GARBAGE = 'not-a-real-value'
  const same = (kind: string, param: string, extra: Record<string, unknown> = {}, t = 1.5) => {
    expect(ev(beh(kind, { ...extra, [param]: GARBAGE }), t)).toEqual(ev(beh(kind, { ...extra }), t))
  }
  it('cascade style falls back to rise', () => same('text.cascade', 'style'))
  it('cascade dir falls back to in', () => same('text.cascade', 'dir'))
  it('maskSlide dir falls back to reveal', () => same('text.maskSlide', 'dir'))
  it('maskSlide from falls back to up', () => same('text.maskSlide', 'from'))
  it('typewriter dir falls back to type', () => same('text.typewriter', 'dir'))
  it('typewriter cursor falls back to bar', () => same('text.typewriter', 'cursor'))
  it('scramble mode falls back to settle', () =>
    same('text.scramble', 'mode', { areaW: 0.5, areaH: 0.5, interval: 0.2, stagger: 0.1 }))
  it('scramble move falls back to snap', () =>
    same('text.scramble', 'move', { areaW: 0.5, areaH: 0.5, interval: 0.2 }))
  it('shared by falls back to letters', () => same('text.cascade', 'by'))
  it('shared order falls back to ltr', () => same('text.cascade', 'order', { stagger: 0.2 }))
})

// `textCanMove` is the cheap gate in front of the whole per-glyph path: it answers "could any
// of these bars move a letter at t" WITHOUT laying out a single cell, so a text layer whose
// entrance finished a second ago goes back to being an ordinary, cacheable text layer.
describe('textCanMove', () => {
  const canMove = (b: any, t: number) => textCanMove(Array.isArray(b) ? b : [b], t)

  it('an entrance is live up to the end of its bar, and inert after it', () => {
    const b = beh('text.cascade', { style: 'fade' })          // 1 → 2
    expect(canMove(b, 0)).toBe(true)                          // before: HIDDEN, not at rest
    expect(canMove(b, 1.5)).toBe(true)
    expect(canMove(b, 2.5)).toBe(false)
  })
  it('a FINISHED exit is NOT inert — its pieces are hidden, not at rest', () => {
    const b = beh('text.cascade', { dir: 'out', style: 'fade' })
    expect(canMove(b, 0.5)).toBe(false)                       // before an exit the text just sits there
    expect(canMove(b, 1.5)).toBe(true)
    expect(canMove(b, 99)).toBe(true)                         // still hidden — the fold must keep drawing it
  })
  it('a span bar is inert on both sides of its bar', () => {
    const b = beh('text.scramble', { mode: 'loop', interval: 0.2 }, 1, 2)
    expect(canMove(b, 0.5)).toBe(false)
    expect(canMove(b, 2)).toBe(true)
    expect(canMove(b, 3.5)).toBe(false)
  })
  it('a spring-tail entrance stays live through the settle tail', () => {
    const ease = { type: 'spring', bounce: 0.6 } as const
    const b = beh('text.cascade', { style: 'rise', ease })
    expect(canMove(b, 2.5)).toBe(true)                        // past the bar, still settling
    expect(canMove(b, 1 + springSettle(0.6) + 0.01)).toBe(false)
    // A kind without the tail gets no extra grace.
    expect(canMove(beh('text.scramble', { mode: 'settle', interval: 0.2, ease }), 2.5)).toBe(false)
  })
  it('the bar delay shifts the whole window', () => {
    const b = { ...beh('text.cascade', { style: 'fade' }), timing: { start: 1, duration: 1, delay: 2 } }
    expect(canMove(b, 2.5)).toBe(true)
    expect(canMove(b, 4.5)).toBe(false)
  })
  it('an unknown kind, a non-text kind and an empty list are inert', () => {
    expect(canMove(beh('text.nope'), 1.5)).toBe(false)
    expect(canMove(beh('fade'), 1.5)).toBe(false)
    expect(textCanMove([], 1.5)).toBe(false)
  })
  it('one live bar is enough', () => {
    expect(canMove([beh('text.cascade', { style: 'fade' }), beh('text.scramble', { mode: 'loop' }, 10, 1)], 1.5)).toBe(true)
  })
})

describe('textCanMove never disagrees with the evaluator', () => {
  const KINDS: Array<[string, Record<string, unknown>]> = [
    ['text.cascade', { style: 'rise', dir: 'in' }],
    ['text.cascade', { style: 'fade', dir: 'out' }],
    ['text.cascade', { style: 'rise', dir: 'in', ease: { type: 'spring', bounce: 0.5 } }],
    ['text.maskSlide', { dir: 'reveal', from: 'up' }],
    ['text.maskSlide', { dir: 'hide', from: 'left' }],
    ['text.typewriter', { dir: 'type', cursor: 'bar', blink: 0 }],
    ['text.typewriter', { dir: 'delete', cursor: 'bar', blink: 0 }],
    ['text.scramble', { mode: 'settle', interval: 0.2 }],
    ['text.scramble', { mode: 'scatter', interval: 0.2 }],
    ['text.scramble', { mode: 'loop', interval: 0.2 }],
    ['text.scramble', { mode: 'settle', interval: 0.2, ease: { type: 'spring', bounce: 0.5 } }],
  ]
  it('whenever it says a layer cannot move, the evaluator is exactly at rest', () => {
    for (const [kind, params] of KINDS) {
      for (const stagger of [0, 0.15]) {
        const b = beh(kind, { ...params, stagger }, 1, 2)
        for (let t = -1; t <= 8.0001; t += 0.05) {
          if (textCanMove([b], t)) continue
          expect(ev(b, t).atRest, `${kind} ${JSON.stringify(params)} stagger=${stagger} t=${t.toFixed(2)}`).toBe(true)
        }
      }
    }
  })
})

describe('finite-number guards', () => {
  it('a NaN stagger falls back to the documented default (0.04)', () => {
    const a = ev(beh('text.cascade', { style: 'fade', order: 'rtl', stagger: NaN }), 1.5)
    const b = ev(beh('text.cascade', { style: 'fade', order: 'rtl', stagger: 0.04 }), 1.5)
    expect(a).toEqual(b)
  })
  it('a NaN seed falls back to the documented default (1)', () => {
    const a = ev(beh('text.scramble', { areaW: 0.5, areaH: 0.5, interval: 0.2, seed: NaN }, 1, 2), 1.5)
    const b = ev(beh('text.scramble', { areaW: 0.5, areaH: 0.5, interval: 0.2, seed: 1 }, 1, 2), 1.5)
    expect(a).toEqual(b)
  })
})
