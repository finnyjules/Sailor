/**
 * Cross-language parity fixture for Cloner Vary.
 *
 * `expandClones` (TypeScript, the single source of truth) and `_expand_clones`
 * (comfy_extras/nodes_compositor.py, its mirror) have to agree copy for copy, or
 * a wired render stops matching the preview it was authored in.
 *
 * This spec is the TYPESCRIPT HALF of that contract: it runs the real
 * `expandClones` over a fixed set of cases and pins the result into
 * `tests/fixtures/cloner-vary-parity.json`. The Python half
 * (tests-unit/comfy_extras_test/cloner_vary_test.py) reads that same file and
 * asserts its own output against it — so the numbers Python is measured against
 * are TypeScript's, never Python's own.
 *
 * Change `expandClones` and this spec fails until you regenerate:
 *
 *     UPDATE_CLONER_VARY_FIXTURE=1 node_modules/.bin/vitest run tests/unit/cloner-vary-parity.unit.spec.ts
 *
 * and regenerating makes the Python side fail in turn until it is mirrored. That
 * is the point: the two cannot drift apart quietly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CLONER, expandClones, type Cloner } from '~/composables/useCloner'

const FIXTURE = fileURLToPath(new URL('../fixtures/cloner-vary-parity.json', import.meta.url))

const C = (over: Partial<Cloner>): Cloner => ({ ...DEFAULT_CLONER, enabled: true, ...over })

/** JSON has no NaN/Infinity. A negative `stepScale` under a fractional exponent
 *  produces NaN in JS, and that IS part of the contract (see the Python guard),
 *  so encode it rather than losing it to `null`. */
const num = (n: number): number | string => (Number.isFinite(n) ? n : String(n))

interface Case { name: string; aspect: number; cloner: Cloner }

const CASES: Case[] = [
  {
    // The zero-change anchor: no vary at all. Must stay byte-identical forever.
    name: 'linear, no vary',
    aspect: 1,
    cloner: C({ countX: 3, spacingX: 0.2, stepScale: 0.5, stepRotation: 10, stepOpacity: 0.9 }),
  },
  {
    name: 'sequence, colour cycle',
    aspect: 1,
    cloner: C({ countX: 4, spacingX: 0.2, stepScale: 0.8, varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'] }),
  },
  {
    // Fractional exponents: this is where Math.pow and Python's ** can part ways.
    name: 'random seed 7, colour cycle',
    aspect: 1,
    cloner: C({
      countX: 4, spacingX: 0.2, stepScale: 0.8, stepOpacity: 0.9, stepRotation: 12,
      varyMode: 'random', varySeed: 7,
      varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'], varyColorSpread: 'cycle',
    }),
  },
  {
    name: 'random seed 3, colour blend, strength 0.4',
    aspect: 1,
    cloner: C({
      countX: 5, spacingX: 0.15, stepScale: 0.7, stepOpacity: 0.8,
      varyMode: 'random', varySeed: 3,
      varyColor: true, varyPalette: ['#123456', '#abcdef'], varyColorSpread: 'blend', varyColorStrength: 0.4,
    }),
  },
  {
    name: 'falloff centred mid-array, colour blend',
    aspect: 1,
    cloner: C({
      countX: 5, spacingX: 0.15, stepScale: 0.5, stepRotation: 10,
      varyMode: 'falloff', varyFalloffCenter: 0.5, varyFalloffRadius: 0.4,
      varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'], varyColorSpread: 'blend',
    }),
  },
  {
    // Random hashes by ARRAY POSITION, so a mirrored twin must NOT reuse its
    // positive twin's draw. Enumeration order is the whole assertion here.
    name: 'grid 3x2 mirrorX, random seed 5',
    aspect: 1.5,
    cloner: C({
      countX: 3, countY: 2, spacingX: 0.2, spacingY: 0.25, mirrorX: true,
      nudgeX: 0.01, staggerY: 0.5, stepScale: 0.9, stepOpacity: 0.95,
      varyMode: 'random', varySeed: 5,
      varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'], varyColorSpread: 'cycle',
    }),
  },
  {
    name: 'radial partial sweep, faceCenter, falloff',
    aspect: 1.7777777777777777,
    cloner: C({
      mode: 'radial', count: 6, radius: 0.3, startAngle: 15, sweepAngle: 240, faceCenter: true,
      stepScale: 0.85, stepOpacity: 0.9,
      varyMode: 'falloff', varyFalloffCenter: 0, varyFalloffRadius: 0.6,
      varyColor: true, varyPalette: ['#4c6ef5', '#f59f00'], varyColorSpread: 'blend',
    }),
  },
  {
    // An emptied palette disables colour even with the flag on.
    name: 'emptied palette disables colour',
    aspect: 1,
    cloner: C({ countX: 3, spacingX: 0.2, varyColor: true, varyPalette: [] }),
  },
  {
    // A single swatch is used for every copy.
    name: 'single-swatch palette',
    aspect: 1,
    cloner: C({ countX: 3, spacingX: 0.2, varyMode: 'random', varySeed: 11, varyColor: true, varyPalette: ['#0abab5'] }),
  },
  {
    // Sequence keeps INTEGRAL exponents, so a negative base is a real number in
    // both languages and must stay one — the NaN guard below must not swallow it.
    name: 'negative stepScale in sequence mode',
    aspect: 1,
    cloner: C({ countX: 4, spacingX: 0.2, stepScale: -0.5 }),
  },
  {
    // A hand-edited widget JSON is not clamped to the panel's 0.5..1.5. JS gives
    // NaN for a negative base under a fractional exponent; Python would return a
    // complex number, so its mirror has to reproduce the NaN deliberately.
    name: 'negative stepScale under a fractional exponent',
    aspect: 1,
    cloner: C({
      countX: 4, spacingX: 0.2, stepScale: -0.5,
      varyMode: 'falloff', varyFalloffCenter: 0, varyFalloffRadius: 0.7,
    }),
  },
  {
    // `#000000` blended toward `#010101` at weight 0.5 (the middle of 3 sequence
    // copies) lands each channel on EXACTLY 0.5 — the one value where JS
    // `Math.round` (half away from zero → 1) and Python's `round()` (half-to-even
    // → 0) disagree. `_rgb_to_hex` uses `math.floor(n + 0.5)` specifically to
    // match JS here; this case is what pins that choice.
    name: 'blend hits an exact channel midpoint (half-up vs half-to-even rounding)',
    aspect: 1,
    cloner: C({
      countX: 3, spacingX: 0.2,
      varyColor: true, varyPalette: ['#000000', '#010101'], varyColorSpread: 'blend',
    }),
  },
  {
    // The panel clamps falloffCenter to 0..1, but a hand-edited widget JSON is
    // not — `varyWeights` clamps it itself. Out-of-range on purpose, so the
    // clamp (not just its usual in-range values 0 and 0.5 elsewhere in this
    // fixture) is what this case pins.
    name: 'falloff centre clamped from an out-of-range value',
    aspect: 1,
    cloner: C({
      countX: 5, spacingX: 0.15, stepScale: 0.6, stepOpacity: 0.85,
      varyMode: 'falloff', varyFalloffCenter: 1.5, varyFalloffRadius: 0.4,
    }),
  },
  {
    // Full ring: sweepAngle >= 359.999 takes the `full ? n : n - 1` denominator
    // branch, untouched by the other radial fixture case (a 240° partial sweep).
    name: 'radial full ring (sweepAngle 360)',
    aspect: 1,
    cloner: C({
      mode: 'radial', count: 5, radius: 0.25, startAngle: 0, sweepAngle: 360,
      stepScale: 0.9,
    }),
  },
  {
    // mirrorY: the grid fixture elsewhere only covers mirrorX.
    name: 'grid mirrorY',
    aspect: 1,
    cloner: C({
      countX: 2, countY: 3, spacingX: 0.2, spacingY: 0.15, mirrorY: true,
      stepScale: 0.85,
    }),
  },
]

const run = (c: Case) =>
  expandClones(c.cloner, c.aspect).map((t) => ({
    dx: num(t.dx), dy: num(t.dy), drot: num(t.drot),
    dscale: num(t.dscale), dopacity: num(t.dopacity),
    weight: num(t.weight), tint: t.tint ?? null, tintStrength: num(t.tintStrength),
  }))

describe('cloner vary cross-language fixture', () => {
  const actual = {
    note: 'Generated from expandClones() by tests/unit/cloner-vary-parity.unit.spec.ts. '
      + 'Read by the Python mirror in tests-unit/comfy_extras_test/cloner_vary_test.py. '
      + 'Regenerate with UPDATE_CLONER_VARY_FIXTURE=1.',
    cases: CASES.map((c) => ({ name: c.name, aspect: c.aspect, cloner: c.cloner, expected: run(c) })),
  }

  if (process.env.UPDATE_CLONER_VARY_FIXTURE) {
    writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n')
  }

  it('still matches the pinned fixture the Python mirror is measured against', () => {
    const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    expect(actual).toEqual(pinned)
  })

  it('covers a case with no vary at all, so the fixture also pins the zero-change path', () => {
    const plain = actual.cases.find((c) => c.name === 'linear, no vary')!
    expect(plain.expected.map((t) => t.dscale)).toEqual([0.25, 0.5, 1])
    expect(plain.expected.every((t) => t.tint === null)).toBe(true)
  })
})
