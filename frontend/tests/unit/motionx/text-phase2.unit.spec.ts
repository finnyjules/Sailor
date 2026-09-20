// Letter behaviours, phase 2 — the three loops (wave / bounce / jitter), Decode and Slot slide.
//
// What is new here is a PER-CELL output: a substitute character (Decode) or a whole reel of
// characters with a position on it (Slot). Everything else — grouping, order, stagger, the
// spring tail, the travelling clip — is phase 1's and is only re-proved where the new kinds
// plug into it.
//
// Every number below is hand-computed from the formulas in the task brief, not read off an
// implementation: the envelope is `smoothstep(be/r) × smoothstep((D−be)/r)` with
// `r = min(0.3, D × 0.25)`, and the phase of a loop is `be × speed − rank × offset`.
import { describe, it, expect } from 'vitest'
import { evaluateTextBehaviours, textBehaviourUsesEase, textCanMove } from '~/lib/motionx/text'
import { charPool, pickChar, type Charset } from '~/lib/motionx/text/charsets'
import { hash01 } from '~/lib/motionx/text/rng'
import { springSettle } from '~/lib/motionx/ease'
import type { TextCell } from '~/lib/motionx/text/units'

const cell = (char: string, x: number, word = 0, line = 0, angle = 0): TextCell => ({ char, x, y: 0, w: 10, h: 20, angle, word, line })
const CELLS = [cell('A', -15), cell('B', -5), cell('C', 5, 1), cell('D', 15, 1)]
const FRAME = { w: 1000, h: 500 }
const beh = (kind: string, params: Record<string, unknown> = {}, start = 1, duration = 2) =>
  ({ id: 'b', layerId: 'L', kind, params: { ease: 'linear', stagger: 0, ...params }, timing: { start, duration } }) as any
const ev = (b: any | any[], t: number, cells = CELLS) => evaluateTextBehaviours(Array.isArray(b) ? b : [b], t, cells, FRAME)

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const NUMBERS = '0123456789'
const SYMBOLS = '#%&@$?!*+=<>/'

// ---------------------------------------------------------------------------
// 1. charsets
// ---------------------------------------------------------------------------
describe('pickChar', () => {
  it('letters answers in the case of the character it stands in for', () => {
    expect(pickChar('letters', 'a', [], 0)).toBe('a')
    expect(pickChar('letters', 'A', [], 0)).toBe('A')
    expect(pickChar('letters', '1', [], 0)).toBe('A')      // uncased → uppercase
    expect(pickChar('letters', 'z', [], 0.999)).toBe('z')
    expect(pickChar('letters', 'Z', [], 0.999)).toBe('Z')
  })

  it('every set answers only from its own characters', () => {
    for (let i = 0; i < 40; i++) {
      const r = i / 40
      expect(UPPER).toContain(pickChar('letters', 'A', CELLS, r))
      expect(NUMBERS).toContain(pickChar('numbers', 'A', CELLS, r))
      expect(SYMBOLS).toContain(pickChar('symbols', 'A', CELLS, r))
      expect(UPPER + NUMBERS + SYMBOLS).toContain(pickChar('mixed', 'A', CELLS, r))
      expect(LOWER + NUMBERS + SYMBOLS).toContain(pickChar('mixed', 'a', CELLS, r))
      expect('ABCD').toContain(pickChar('text', 'A', CELLS, r))
    }
  })

  it('the text set is the distinct non-space characters of the layer', () => {
    expect(charPool('text', 'A', CELLS)).toEqual(['A', 'B', 'C', 'D'])
    expect(charPool('text', 'A', [cell('B', 0), cell('A', 0), cell('B', 0)])).toEqual(['B', 'A'])
  })

  it('too little text to scramble falls back to the alphabet, in the right case', () => {
    expect(charPool('text', 'a', [cell('a', 0), cell('a', 0)])).toEqual(Array.from(LOWER))
    expect(charPool('text', 'A', [])).toEqual(Array.from(UPPER))
    expect(charPool('text', 'A', [cell(' ', 0), cell('A', 0)])).toEqual(Array.from(UPPER))
  })

  it('is a pure function of r', () => {
    expect(pickChar('mixed', 'A', CELLS, 0.42)).toBe(pickChar('mixed', 'A', CELLS, 0.42))
    expect(pickChar('text', 'A', CELLS, 0)).toBe('A')
    expect(pickChar('text', 'A', CELLS, 0.999)).toBe('D')
  })
})

// ---------------------------------------------------------------------------
// 2. the loops
// ---------------------------------------------------------------------------
describe('text.wave', () => {
  // amount 0.5 × piece height 20 = a 10px swing; speed 0.25 puts φ = 0.25 (the crest) at
  // one second into the bar.
  const W = (p: Record<string, unknown> = {}, start = 1, dur = 2) =>
    beh('text.wave', { amount: 0.5, speed: 0.25, offset: 0, ...p }, start, dur)

  it('is at rest on both sides of its bar', () => {
    expect(ev(W(), 0.5).atRest).toBe(true)
    expect(ev(W(), 3.5).atRest).toBe(true)
    expect(ev(W(), 2).atRest).toBe(false)
  })

  it('rides a sine of the bar clock', () => {
    expect(ev(W(), 2).cells[0]!.y).toBeCloseTo(-10, 6)                       // env 1, sin(2π·0.25) = 1
    expect(ev(W(), 2.5).cells[0]!.y).toBeCloseTo(-10 * Math.SQRT1_2, 6)      // sin(2π·0.375)
    expect(ev(W(), 3 - 1e-9).cells[0]!.y).toBeCloseTo(0, 5)                  // sin(2π·0.5) = 0
  })

  it('fades in over the first quarter of the bar and out over the last', () => {
    const b = W({ speed: 2.5 }, 1, 0.8)      // D 0.8 → ramp r = 0.2s
    expect(ev(b, 1.1).cells[0]!.y).toBeCloseTo(-5, 6)                        // env 0.5, sin(2π·0.25) = 1
    expect(ev(b, 1.7).cells[0]!.y).toBeCloseTo(5, 6)                         // env 0.5, sin(2π·1.75) = −1
    expect(ev(b, 1.35).cells[0]!.y).toBeCloseTo(10 * Math.SQRT1_2, 6)        // env 1, sin(2π·0.875)
  })

  it('the ramp is capped at 0.3s however long the bar', () => {
    const f = ev(W({ speed: 1 }, 1, 4), 1.15)      // D 4: a quarter of it would be a whole second
    expect(f.cells[0]!.y).toBeCloseTo(-0.5 * 20 * 0.5 * Math.sin(2 * Math.PI * 0.15), 6)   // env exactly 0.5 at r = 0.3
  })

  it('the envelope is essentially nothing at either edge of the bar', () => {
    const b = W({ speed: 2.5 }, 1, 0.8)
    expect(Math.abs(ev(b, 1.001).cells[0]!.y)).toBeLessThan(1e-4)
    expect(Math.abs(ev(b, 1.799).cells[0]!.y)).toBeLessThan(1e-4)
    expect(ev(b, 1).atRest).toBe(true)
    expect(ev(b, 1.8).atRest).toBe(true)
  })

  it('offset lags each rank by a fraction of a cycle', () => {
    const f = ev(W({ offset: 0.25 }), 2)
    expect(f.cells[0]!.y).toBeCloseTo(-10, 6)      // φ  0.25
    expect(f.cells[1]!.y).toBeCloseTo(0, 6)        // φ  0
    expect(f.cells[2]!.y).toBeCloseTo(10, 6)       // φ −0.25
    expect(f.cells[3]!.y).toBeCloseTo(0, 6)        // φ −0.5
  })

  it('by words: the letters of a word ride together', () => {
    const f = ev(W({ offset: 0.25, by: 'words' }), 2)
    expect(f.cells[1]!.y).toBeCloseTo(f.cells[0]!.y, 6)
    expect(f.cells[3]!.y).toBeCloseTo(f.cells[2]!.y, 6)
    expect(f.cells[2]!.y).not.toBeCloseTo(f.cells[0]!.y, 6)
  })
})

describe('text.bounce', () => {
  // speed 1.5 puts the bar's middle in the SECOND hop, where a plain sine would already have
  // gone negative — it is the absolute value that keeps every hop above the line.
  const B = (p: Record<string, unknown> = {}) => beh('text.bounce', { amount: 0.5, speed: 1.5, offset: 0, ...p }, 1, 2)

  it('peaks a hand-computed height above the baseline on every hop', () => {
    expect(ev(B(), 2).cells[0]!.y).toBeCloseTo(-10, 6)                      // env 1, |sin(π·1.5)| = 1
    expect(ev(B({ speed: 0.5 }), 2).cells[0]!.y).toBeCloseTo(-10, 6)        // env 1, |sin(π·0.5)| = 1
    expect(ev(B(), 1 + 4 / 3).cells[0]!.y).toBeCloseTo(0, 5)                // |sin(π·2)| = 0 — back on the line
  })

  it('never dips below the baseline', () => {
    for (let t = 1.01; t < 3; t += 0.01) for (const c of ev(B(), t).cells) expect(c.y).toBeLessThanOrEqual(1e-9)
  })

  it('is at rest on both sides of its bar', () => {
    expect(ev(B(), 0.5).atRest).toBe(true)
    expect(ev(B(), 3.5).atRest).toBe(true)
    expect(ev(B(), 2).atRest).toBe(false)
  })
})

describe('text.jitter', () => {
  const J = (p: Record<string, unknown> = {}) => beh('text.jitter', { amount: 0.5, speed: 10, seed: 7, ...p }, 1, 2)
  const SPIN = (6 * Math.PI) / 180
  const shake = (k: number, i: number, channel: number) => 0.5 * 20 * (hash01(7, i, k, channel) - 0.5) * 2

  it('holds one hashed shake for a whole tick, then cuts to the next', () => {
    const a = ev(J(), 2).cells[0]!, b = ev(J(), 2.05).cells[0]!, c = ev(J(), 2.15).cells[0]!
    expect(a.x).toBeCloseTo(CELLS[0]!.x + shake(10, 0, 1), 6)
    expect(a.y).toBeCloseTo(shake(10, 0, 2), 6)
    expect(a.rotation).toBeCloseTo((hash01(7, 0, 10, 3) - 0.5) * 2 * SPIN, 6)
    expect([b.x, b.y]).toEqual([a.x, a.y])
    expect([c.x, c.y]).not.toEqual([a.x, a.y])
  })

  it('same seed same frame; another seed another frame', () => {
    expect(ev(J({ seed: 3 }), 2)).toEqual(ev(J({ seed: 3 }), 2))
    expect(ev(J({ seed: 4 }), 2)).not.toEqual(ev(J({ seed: 3 }), 2))
  })

  it('ignores offset — every letter shakes on the same clock', () => {
    expect(ev(J({ offset: 0.5 }), 2)).toEqual(ev(J({ offset: 0 }), 2))
  })

  it('is at rest on both sides of its bar', () => {
    expect(ev(J(), 0.5).atRest).toBe(true)
    expect(ev(J(), 3.5).atRest).toBe(true)
    expect(ev(J(), 2).atRest).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. decode
// ---------------------------------------------------------------------------
describe('text.decode', () => {
  const D = (p: Record<string, unknown> = {}, start = 1, dur = 1) =>
    beh('text.decode', { rate: 10, seed: 5, charset: 'text', ...p }, start, dur)
  const flicker = (i: number, barElapsed: number, rate = 10, set: Charset = 'text') =>
    pickChar(set, CELLS[i]!.char, CELLS, hash01(5, i, Math.floor(barElapsed * rate)))

  it('resolve: the text is simply at rest before the bar (every letter shows from the first frame, nothing is revealed), exactly at rest after it', () => {
    expect(ev(D(), 0.5).atRest).toBe(true)
    expect(ev(D({ hideBefore: true }), 0.5).cells.every((c) => c.opacity === 0)).toBe(true)
    expect(ev(D(), 2.5).atRest).toBe(true)
    expect(ev(D(), 2.5).cells.every((c) => c.char === undefined)).toBe(true)
  })

  it('mid-bar every letter sits in its place, fully visible, wearing a stand-in character', () => {
    const f = ev(D(), 1.5)
    f.cells.forEach((c, i) => {
      expect(c.opacity).toBe(1)
      expect(c.x).toBeCloseTo(CELLS[i]!.x, 6)
      expect(c.y).toBeCloseTo(0, 6)
      expect(c.scale).toBe(1)
      expect(c.char).toBe(flicker(i, 0.5))
      expect('ABCD').toContain(c.char!)
    })
  })

  it('the flicker holds for one over the rate and changes on the next tick', () => {
    const at = (t: number) => ev(D(), t).cells.map((c) => c.char)
    expect(at(1.05)).toEqual(at(1.09))
    expect(at(1.15)).not.toEqual(at(1.05))
    expect(at(1.15)).toEqual(CELLS.map((_, i) => flicker(i, 0.15)))
  })

  it('another charset swaps the pool', () => {
    for (const c of ev(D({ charset: 'numbers' }), 1.5).cells) expect(NUMBERS).toContain(c.char!)
    for (const c of ev(D({ charset: 'symbols' }), 1.5).cells) expect(SYMBOLS).toContain(c.char!)
  })

  // The `wholeBar` rule: with a stagger, a letter that has already landed is LOCKED while the
  // ones whose own turn has not come yet are already flickering — the whole word churns from
  // the bar's first frame and resolves left to right.
  it('with a stagger the first letter locks while every other one is already flickering', () => {
    const f = ev(D({ stagger: 0.25 }), 1.3)      // delays 0 / .25 / .5 / .75, pieceDur 0.25
    expect(f.cells[0]!.char).toBeUndefined()
    expect(f.cells[0]!.opacity).toBe(1)
    expect(f.cells[1]!.char).toBeDefined()
    expect(f.cells[2]!.char).toBeDefined()
    expect(f.cells[3]!.char).toBeDefined()       // its own turn has not started — still flickering
    expect(f.cells[3]!.opacity).toBe(1)
    // and every one of them ticks on the BAR's clock, not on its own staggered one
    expect(f.cells[1]!.char).toBe(flicker(1, 0.3))
    expect(f.cells[3]!.char).toBe(flicker(3, 0.3))
  })

  it('the rate never falls below one flicker a second', () => {
    const slow = D({ rate: 0 }, 1, 4)
    expect(ev(slow, 3.5).cells.map((c) => c.char)).toEqual(CELLS.map((_, i) => flicker(i, 2.5, 1)))
    expect(ev(D({ rate: -5 }, 1, 4), 3.5).cells.map((c) => c.char)).toEqual(CELLS.map((_, i) => flicker(i, 2.5, 1)))
  })

  it('dissolve mirrors resolve: at rest before the bar, gone after it', () => {
    const b = D({ dir: 'dissolve' })
    expect(ev(b, 0.5).atRest).toBe(true)
    expect(ev(b, 1.5).cells.every((c) => c.char !== undefined && c.opacity === 1)).toBe(true)
    expect(ev(b, 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })

  it('a staggered dissolve keeps churning to the END of the bar, then goes at once', () => {
    const b = D({ dir: 'dissolve', stagger: 0.25 })
    const f = ev(b, 1.6)                         // piece 0 spent its own progress at 1.25
    expect(f.cells[0]!.opacity).toBe(1)
    expect(f.cells[0]!.char).toBeDefined()
    expect(ev(b, 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. slot
// ---------------------------------------------------------------------------
describe('text.slot', () => {
  const S = (p: Record<string, unknown> = {}, start = 1, dur = 1) =>
    beh('text.slot', { steps: 8, seed: 9, filler: 'letters', ...p }, start, dur)
  const filler = (i: number, j: number, set: Charset = 'letters') => pickChar(set, CELLS[i]!.char, CELLS, hash01(9, i, j))

  it('the reel is the fillers it rolls through, then the real character', () => {
    const r = ev(S(), 1.5).cells[0]!.reel!                             // pos 4 → the window is 3…5
    expect(r.chars.length).toBe(9)                                     // steps 8 + the real one
    expect(r.chars.slice(3, 6)).toEqual([4, 5, 6].map((j) => filler(0, j)))
    expect(r.roll).toBe(1)
    const late = ev(S(), 1.95).cells[0]!.reel!                         // pos 7.6 → the window is 6…9
    expect(late.chars[8]).toBe('A')
    expect(late.chars[7]).toBe(filler(0, 8))
  })

  // The draw inks the four characters around `pos` and nothing else, so building all 41 of a
  // 40-step reel — for every live glyph, every frame — is work thrown away.
  it('only the characters the draw can reach are built; the rest are empty', () => {
    const r = ev(S(), 1.5).cells[0]!.reel!                             // pos 4 → floor−1 … ceil+1
    expect(r.chars.map((c) => c !== '')).toEqual([false, false, false, true, true, true, false, false, false])
    const big = ev(S({ steps: 40 }), 1.5).cells[0]!.reel!              // pos 20
    expect(big.chars.length).toBe(41)
    expect(big.chars.filter((c) => c !== '').length).toBe(3)
    expect(big.chars.slice(19, 22)).toEqual([20, 21, 22].map((j) => filler(0, j)))
  })

  it('steps says how many characters roll past before it lands', () => {
    expect(ev(S({ steps: 3 }), 1.5).cells[0]!.reel!.chars.length).toBe(4)
    expect(ev(S({ steps: 3 }), 1.5).cells[0]!.reel!.pos).toBeCloseTo(1.5, 6)
    expect(ev(S({ steps: 100 }), 1.5).cells[0]!.reel!.chars.length).toBe(41)   // clamped to 40
    expect(ev(S({ steps: 0 }), 1.5).cells[0]!.reel!.chars.length).toBe(2)      // clamped to 1
    expect(ev(S({ steps: NaN }), 1.5).cells[0]!.reel!.chars.length).toBe(9)    // back to the default
  })

  it('the reel runs 0 → steps across the bar and is gone once it has landed', () => {
    expect(ev(S(), 1.001).cells[0]!.reel!.pos).toBeCloseTo(0.008, 6)
    expect(ev(S(), 1.5).cells[0]!.reel!.pos).toBeCloseTo(4, 6)
    expect(ev(S(), 1.999).cells[0]!.reel!.pos).toBeCloseTo(7.992, 6)
    expect(ev(S(), 2.5).cells[0]!.reel).toBeUndefined()
    expect(ev(S(), 2.5).atRest).toBe(true)
    expect(ev(S(), 0.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })

  it('rolling down flips the sign', () => {
    expect(ev(S({ roll: 'down' }), 1.5).cells[0]!.reel!.roll).toBe(-1)
  })

  it('the letter itself never moves — the reel does', () => {
    ev(S(), 1.5).cells.forEach((c, i) => {
      expect(c.x).toBeCloseTo(CELLS[i]!.x, 6)
      expect(c.y).toBeCloseTo(0, 6)
      expect(c.opacity).toBe(1)
      expect(c.scale).toBe(1)
      expect(c.rotation).toBe(0)
    })
  })

  // The window carries the painter's standard 15% pad, exactly as a mask slide's does: a box
  // measured from the font size shaves an accented cap or a tall ascender, and a reel that
  // shaved its landing character would un-shave it the instant the static path took over. The
  // neighbours are kept out by the PITCH (a full window apart), not by a tight window.
  it('the reel is clipped to the cell\'s own box, padded like every other window', () => {
    expect(ev(S(), 1.5).cells[0]!.clip).toEqual({ x: -15, y: 0, w: 16 * 1.1, h: 20, angle: 0, pad: 0.15 })
    expect(ev(S(), 1.5).cells[3]!.clip).toEqual({ x: 15, y: 0, w: 16 * 1.1, h: 20, angle: 0, pad: 0.15 })
  })

  it('a spring rolls past the landing and comes back', () => {
    const b = S({ ease: { type: 'spring', bounce: 0.6 } })
    const positions = [1.5, 1.6, 1.65, 1.7, 1.8, 2, 2.2].map((t) => ev(b, t).cells[0]!.reel?.pos ?? 0)
    expect(Math.max(...positions)).toBeGreaterThan(8)
    expect(ev(b, 2.01).atRest).toBe(false)
    expect(ev(b, 1 + springSettle(0.6) + 0.01).atRest).toBe(true)
  })

  // Steps is a LOOK control — how many characters flick past. A spring's overshoot is a fixed
  // fraction of its travel, so multiplying the whole position by Steps would multiply the
  // overshoot too: at 40 steps the reel would fly ten windows past the landing (a blank slot)
  // before flying back. The overshoot is a fixed number of WINDOWS past the landing instead.
  it('a spring overshoots the landing by the same amount whatever the Steps', () => {
    const overshoot = (steps: number) => {
      let max = -Infinity
      for (let t = 1; t <= 1 + springSettle(0.6) + 0.01; t += 0.005) {
        const r = ev(S({ steps, ease: { type: 'spring', bounce: 0.6 } }), t).cells[0]!.reel
        if (r) max = Math.max(max, r.pos - steps)
      }
      return max
    }
    const few = overshoot(3), many = overshoot(40)
    expect(few).toBeGreaterThan(0)
    expect(few).toBeLessThan(1)                    // never a whole window past the landing
    expect(Math.abs(few - many)).toBeLessThan(1e-9)
  })

  it('out: the real character leads the reel, which rolls off into nothing', () => {
    const early = ev(S({ dir: 'out' }), 1.05).cells[0]!.reel!   // pos 0.45 → the window is −1…2
    expect(early.chars.length).toBe(10)             // real + 8 fillers + the empty landing
    expect(early.chars[0]).toBe('A')
    expect(early.chars[1]).toBe(filler(0, 1))
    expect(ev(S({ dir: 'out' }), 1.5).cells[0]!.reel!.pos).toBeCloseTo(4.5, 6)   // e 0.5 × (steps + 1)
    const late = ev(S({ dir: 'out' }), 1.95).cells[0]!.reel!    // pos 8.55 → the window is 7…10
    expect(late.chars[9]).toBe('')
    expect(late.chars[8]).toBe(filler(0, 8))
    expect(ev(S({ dir: 'out' }), 0.5).atRest).toBe(true)
    expect(ev(S({ dir: 'out' }), 2.5).cells.every((c) => c.opacity === 0)).toBe(true)
  })

  it('by words: every letter of a word shares one reel position, with its own characters', () => {
    const f = ev(S({ by: 'words', stagger: 0.2 }), 1.75)        // piece 0 at pos 7.5 — the landing
    expect(f.cells[1]!.reel!.pos).toBeCloseTo(f.cells[0]!.reel!.pos, 6)
    expect(f.cells[0]!.reel!.chars[8]).toBe('A')
    expect(f.cells[1]!.reel!.chars[8]).toBe('B')
    expect(f.cells[2]!.reel!.pos).not.toBeCloseTo(f.cells[0]!.reel!.pos, 6)
  })

  it('the filler charset is configurable; only the landing is the real character', () => {
    ev(S({ filler: 'numbers' }), 1.5).cells.forEach((c) => {     // pos 4 — fillers only
      for (const f of c.reel!.chars.filter(Boolean)) expect(NUMBERS).toContain(f)
    })
    ev(S({ filler: 'numbers' }), 1.95).cells.forEach((c, i) => { // pos 7.6 — the landing is in reach
      expect(c.reel!.chars[8]).toBe(CELLS[i]!.char)
    })
  })
})

// ---------------------------------------------------------------------------
// 5. composition — a reel's window has to travel with its letter, exactly as a mask slide's does
// ---------------------------------------------------------------------------
describe('a slot reel composed with another bar keeps its window on the glyph', () => {
  const slot = { ...beh('text.slot', { steps: 6, seed: 9 }, 1, 2), id: 'sl' }
  const scramble = { ...beh('text.scramble', { mode: 'settle', areaW: 0.5, areaH: 0.5, interval: 0.2 }, 1, 2), id: 'sc' }

  const clipRidesTheCell = (f: ReturnType<typeof ev>) => {
    f.cells.forEach((c, i) => {
      expect(c.reel, `cell ${i} lost its reel`).toBeDefined()
      expect(c.clip, `cell ${i} lost its clip`).toBeDefined()
      expect(c.x, `cell ${i} drawn outside its clip in x`).toBeCloseTo(c.clip!.x, 6)
      expect(c.y, `cell ${i} drawn outside its clip in y`).toBeCloseTo(c.clip!.y, 6)
      expect(c.clip!.pad).toBe(0.15)
    })
  }

  it('slot + scramble: the window travels with the scrambled letter, in either order', () => {
    clipRidesTheCell(ev([slot, scramble], 2))
    clipRidesTheCell(ev([scramble, slot], 2))
  })

  // TWO WINDOWS ON ONE GLYPH INTERSECT. A slot reel's window and a mask slide's window are
  // both "the part of the layer this letter may be seen through", so wearing both means
  // wearing both: the last one must not simply replace the first, or a Slot would quietly
  // cancel the Mask slide it was added on top of (and vice versa).
  describe('a slot window and a mask window intersect', () => {
    const slot = { ...beh('text.slot', { steps: 6, seed: 9 }, 1, 2), id: 'sl' }
    const mask = { ...beh('text.maskSlide', { dir: 'reveal', from: 'up' }, 1, 2), id: 'mk' }
    // t 1.5 → e 0.25, so the mask has its letters 15px (0.75 × 20) below their place, still
    // travelling up through a window that reaches only 10px above the resting centre.
    const T = 1.5

    it('either order draws exactly the same frame', () => {
      expect(ev([slot, mask], T)).toEqual(ev([mask, slot], T))
    })

    it('the window is the OVERLAP of the two, hand-computed', () => {
      // slot's window (the cell box, 17.6 × 20, carried up by the mask's own travel) spans
      // x −23.8…−6.2, y 5…25; the mask's (the piece box, 10 × 20, left at rest) spans
      // x −20…−10, y −10…10. The overlap is x −20…−10, y 5…10.
      expect(ev([slot, mask], T).cells[0]!.clip).toEqual({ x: -15, y: 7.5, w: 10, h: 5, angle: 0, pad: 0.15 })
    })

    it('and it really masks: the glyph\'s own centre is outside it', () => {
      const c = ev([slot, mask], T).cells[0]!
      expect(c.y).toBeCloseTo(15, 6)
      expect(Math.abs(c.y - c.clip!.y)).toBeGreaterThan(c.clip!.h / 2)
    })

    it('a window each bar could keep on its own is inside both of them', () => {
      const both = ev([slot, mask], T).cells[0]!.clip!
      const alone = ev(slot, T).cells[0]!.clip!          // the cell box, at rest
      const masked = ev(mask, T).cells[0]!.clip!         // the piece box, at rest
      // The slot's own window travels with its letter, so it is compared where the mask put it.
      for (const [w, dy] of [[alone, 15], [masked, 0]] as const) {
        expect(both.x - both.w / 2).toBeGreaterThanOrEqual(w.x - w.w / 2 - 1e-9)
        expect(both.x + both.w / 2).toBeLessThanOrEqual(w.x + w.w / 2 + 1e-9)
        expect(both.y - both.h / 2).toBeGreaterThanOrEqual(w.y + dy - w.h / 2 - 1e-9)
        expect(both.y + both.h / 2).toBeLessThanOrEqual(w.y + dy + w.h / 2 + 1e-9)
      }
    })

    it('two windows that miss each other leave a hole of nothing, not a wrong window', () => {
      const up = { ...beh('text.maskSlide', { from: 'up' }, 1, 2), id: 'u' }
      const down = { ...beh('text.maskSlide', { from: 'down' }, 1, 2), id: 'd' }
      const clip = ev([up, down], T).cells[0]!.clip!     // one window 15px up, the other 15px down
      expect(clip.w).toBe(0)
      expect(clip.h).toBe(0)
    })

    it('windows at DIFFERENT angles cannot be intersected, so the last one wins', () => {
      // On curved text a word piece's angle is the average of its letters'; one letter's own
      // box is turned by its own angle. There is no axis-aligned overlap of the two.
      const curved = [cell('A', -15, 0, 0, 0.2), cell('B', -5, 0, 0, -0.2)]
      const byWords = (b: any) => ({ ...b, params: { ...b.params, by: 'words' } })
      expect(ev([byWords(slot), byWords(mask)], T, curved).cells[0]!.clip!.angle).toBeCloseTo(0, 9)
      expect(ev([byWords(mask), byWords(slot)], T, curved).cells[0]!.clip!.angle).toBeCloseTo(0.2, 9)
    })
  })

  it('a later behaviour that names a character wins', () => {
    const decode = { ...beh('text.decode', { rate: 10, seed: 5 }, 1, 2), id: 'dc' }
    const decode2 = { ...beh('text.decode', { rate: 10, seed: 77 }, 1, 2), id: 'dc2' }
    const f = ev([decode, decode2], 2)
    expect(f.cells[0]!.char).toBe(ev(decode2, 2).cells[0]!.char)
    expect(f.cells[0]!.char).not.toBe(ev(decode, 2).cells[0]!.char)
  })
})

// ---------------------------------------------------------------------------
// 6. "uses easing" — what the inspector asks before it shows an Easing control
// ---------------------------------------------------------------------------
describe('textBehaviourUsesEase', () => {
  it('kinds that interpolate use the curve; kinds that cut or tick do not', () => {
    expect(textBehaviourUsesEase('text.cascade')).toBe(true)
    expect(textBehaviourUsesEase('text.maskSlide')).toBe(true)
    expect(textBehaviourUsesEase('text.slot')).toBe(true)
    expect(textBehaviourUsesEase('text.typewriter')).toBe(false)
    expect(textBehaviourUsesEase('text.decode')).toBe(false)
    expect(textBehaviourUsesEase('text.wave')).toBe(false)
    expect(textBehaviourUsesEase('text.bounce')).toBe(false)
    expect(textBehaviourUsesEase('text.jitter')).toBe(false)
  })

  it('scramble uses it only when it glides between spots', () => {
    expect(textBehaviourUsesEase('text.scramble', { move: 'glide' })).toBe(true)
    expect(textBehaviourUsesEase('text.scramble', { move: 'snap' })).toBe(false)
    expect(textBehaviourUsesEase('text.scramble')).toBe(false)                      // snap is the default
    expect(textBehaviourUsesEase('text.scramble', { move: 'nonsense' })).toBe(false)
  })

  it('a kind nobody registered uses nothing', () => {
    expect(textBehaviourUsesEase('text.nope')).toBe(false)
    expect(textBehaviourUsesEase('fade')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. textCanMove — the new kinds are ordinary in / out / span bars
// ---------------------------------------------------------------------------
describe('textCanMove, for the new kinds', () => {
  it('a loop is inert on both sides of its bar', () => {
    for (const kind of ['text.wave', 'text.bounce', 'text.jitter']) {
      const b = beh(kind, {}, 1, 2)
      expect(textCanMove([b], 0.5), kind).toBe(false)
      expect(textCanMove([b], 2), kind).toBe(true)
      expect(textCanMove([b], 3.5), kind).toBe(false)
    }
  })

  it('decode resolve goes inert after its bar; a dissolve never does', () => {
    // A decode no longer hides the text before its bar (nothing is revealed through it), so
    // there is nothing to draw until it starts — unless the bar opts back in.
    expect(textCanMove([beh('text.decode', {}, 1, 2)], 0.5)).toBe(false)
    expect(textCanMove([beh('text.decode', { hideBefore: true }, 1, 2)], 0.5)).toBe(true)
    expect(textCanMove([beh('text.decode', {}, 1, 2)], 3.5)).toBe(false)
    expect(textCanMove([beh('text.decode', { dir: 'dissolve' }, 1, 2)], 0.5)).toBe(false)
    expect(textCanMove([beh('text.decode', { dir: 'dissolve' }, 1, 2)], 3.5)).toBe(true)
  })

  it('a slot stays live through its spring tail', () => {
    const ease = { type: 'spring', bounce: 0.6 } as const
    expect(textCanMove([beh('text.slot', { ease }, 1, 1)], 2.5)).toBe(true)
    expect(textCanMove([beh('text.slot', { ease }, 1, 1)], 1 + springSettle(0.6) + 0.01)).toBe(false)
    expect(textCanMove([beh('text.slot', {}, 1, 1)], 2.5)).toBe(false)
  })
})

describe('textCanMove never disagrees with the evaluator, for the new kinds', () => {
  const KINDS: Array<[string, Record<string, unknown>]> = [
    ['text.wave', {}],
    ['text.bounce', {}],
    ['text.jitter', {}],
    ['text.decode', { dir: 'resolve' }],
    ['text.decode', { dir: 'dissolve' }],
    ['text.slot', { dir: 'in' }],
    ['text.slot', { dir: 'out' }],
    ['text.slot', { dir: 'in', ease: { type: 'spring', bounce: 0.5 } }],
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

// ---------------------------------------------------------------------------
// 8. guards — every enum through oneOf, every number through the finite guard
// ---------------------------------------------------------------------------
describe('unknown enum values fall back to their documented default', () => {
  const GARBAGE = 'not-a-real-value'
  const same = (kind: string, param: string, extra: Record<string, unknown> = {}, t = 1.5) => {
    expect(ev(beh(kind, { ...extra, [param]: GARBAGE }, 1, 2), t)).toEqual(ev(beh(kind, extra, 1, 2), t))
  }
  it('decode dir falls back to resolve', () => same('text.decode', 'dir'))
  it('decode charset falls back to text', () => same('text.decode', 'charset'))
  it('slot dir falls back to in', () => same('text.slot', 'dir'))
  it('slot roll falls back to up', () => same('text.slot', 'roll'))
  it('slot filler falls back to letters', () => same('text.slot', 'filler'))
})

describe('the documented defaults', () => {
  const D = (p: Record<string, unknown>) => beh('text.decode', { seed: 5, ...p }, 1, 2)
  const S = (p: Record<string, unknown>) => beh('text.slot', { seed: 9, ...p }, 1, 2)

  it('decode stands the layer\'s own text in for itself, 14 times a second', () => {
    expect(ev(D({}), 1.5)).toEqual(ev(D({ charset: 'text', rate: 14 }), 1.5))
    expect(ev(D({}), 1.5)).not.toEqual(ev(D({ charset: 'letters' }), 1.5))
    expect(ev(D({}), 1.5)).not.toEqual(ev(D({ rate: 3 }), 1.5))
  })

  it('a slot rolls eight letters past, upwards', () => {
    expect(ev(S({}), 1.5)).toEqual(ev(S({ steps: 8, filler: 'letters', roll: 'up' }), 1.5))
    expect(ev(S({}), 1.5)).not.toEqual(ev(S({ filler: 'text' }), 1.5))
    expect(ev(S({}), 1.5).cells[0]!.reel!.chars.length).toBe(9)
    expect(ev(S({}), 1.5).cells[0]!.reel!.roll).toBe(1)
  })
})

describe('finite-number guards on the new params', () => {
  const same = (kind: string, params: Record<string, unknown>, fallback: Record<string, unknown>, t = 2) => {
    expect(ev(beh(kind, params, 1, 2), t)).toEqual(ev(beh(kind, fallback, 1, 2), t))
  }
  it('a NaN amount / speed / offset falls back on a loop', () => {
    same('text.wave', { amount: NaN, speed: NaN, offset: NaN }, { amount: 0.25, speed: 1, offset: 0.12 })
    same('text.bounce', { amount: NaN, speed: NaN }, { amount: 0.35, speed: 1.4 })
    same('text.jitter', { amount: NaN, speed: NaN }, { amount: 0.08, speed: 12 })
  })
  it('a NaN rate falls back on decode', () => {
    same('text.decode', { rate: NaN }, { rate: 14 })
  })
})

// "Same as the text" used to mean a SHUFFLE of the text's own letters, which reads on screen
// as random letters. The two meanings are now two options.
describe('text.slot filler: the two "from the text" options', () => {
  const WORD = Array.from('ALBAN').map((ch, i) => cell(ch, i * 10))
  const reels = (params: Record<string, unknown>) => {
    const b = beh('text.slot', { ease: 'linear', stagger: 0, steps: 8, ...params }, 0, 2)
    const out: { real: string; chars: string[] }[] = []
    for (let t = 0.05; t < 2; t += 0.05) {
      ev(b, t, WORD).cells.forEach((c, i) => { if (c.reel) out.push({ real: WORD[i]!.char, chars: c.reel.chars.filter(Boolean) }) })
    }
    return out
  }
  it('"same" rolls every window through its OWN letter, in and out', () => {
    for (const dir of ['in', 'out']) {
      const seen = reels({ filler: 'same', dir })
      expect(seen.length).toBeGreaterThan(0)
      for (const r of seen) expect(r.chars.every((ch) => ch === r.real)).toBe(true)
    }
  })
  it('"text" rolls through the letters of the whole text and nothing else', () => {
    const seen = new Set(reels({ filler: 'text' }).flatMap((r) => r.chars))
    expect([...seen].sort()).toEqual(['A', 'B', 'L', 'N'])
  })
  it('"same" is a slot-only option — decode ignores it and keeps its default', () => {
    const a = beh('text.decode', { charset: 'same' }), d = beh('text.decode', {})
    expect(ev(a, 1.5)).toEqual(ev(d, 1.5))
  })
})
