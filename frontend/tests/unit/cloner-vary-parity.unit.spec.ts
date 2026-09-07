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

/** Every vary key a saved cloner may carry. */
const VARY_KEYS = [
  'varyMode', 'varySeed', 'varyFalloffCenter', 'varyFalloffRadius',
  'varyColor', 'varyPalette', 'varyColorSpread', 'varyColorStrength',
] as const

/**
 * A cloner with its vary keys REMOVED — anything `over` names is kept.
 *
 * This is what a cloner saved before Vary shipped actually looks like, and it is the
 * only shape that makes each side's own fallback defaults observable: `varyOf`
 * (composables/useCloner.ts) and `_vary_of` (comfy_extras/nodes_compositor.py) each
 * substitute their own constants, and Python's `_DEFAULT_VARY` was a hand-copy that
 * nothing cross-checked. Change a default on the JavaScript side and regenerate, and
 * the Python mirror now goes red until it is changed too — same contract the pinned
 * hash values and the whole-cloner cases already have.
 */
const noVary = (over: Partial<Cloner>): Cloner => {
  const c = { ...C(over) } as Record<string, unknown>
  for (const k of VARY_KEYS) if (!(k in over)) delete c[k]
  return c as Cloner
}

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
  // ── Fallback defaults ────────────────────────────────────────────────────────
  // Four cases whose cloners omit vary keys, so BOTH sides' defaults are what the
  // fixture pins. Between them every field of `DEFAULT_VARY` / `_DEFAULT_VARY` reaches
  // the output: mode and strength from the first (a bare pre-Vary cloner), palette and
  // spread from the second, the two falloff dials from the third, seed from the fourth.
  {
    // A cloner saved before Vary existed: not one vary key on it.
    name: 'no vary keys at all — both sides fall back to their own defaults',
    aspect: 1,
    cloner: noVary({ countX: 4, spacingX: 0.2, stepScale: 0.8, stepRotation: 12, stepOpacity: 0.9 }),
  },
  {
    // Colour on, nothing else said: the DEFAULT palette and the DEFAULT spread are
    // what draw the tints, and the default strength is what `tintStrength` reports.
    name: 'colour on with no palette, spread or strength — default palette and spread',
    aspect: 1,
    cloner: noVary({ countX: 4, spacingX: 0.2, stepScale: 0.9, varyColor: true }),
  },
  {
    // Falloff with neither dial set: the default centre and reach shape the weights.
    name: 'falloff with no centre or reach — default falloff dials',
    aspect: 1,
    cloner: noVary({ countX: 5, spacingX: 0.15, stepScale: 0.7, varyMode: 'falloff' }),
  },
  {
    // Random with no seed: the default seed is what the hash is drawn against.
    name: 'random with no seed — default seed',
    aspect: 1,
    cloner: noVary({ countX: 5, spacingX: 0.15, stepScale: 0.7, varyMode: 'random' }),
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

  it('pins the fallback defaults through a cloner that carries no vary keys', () => {
    // The guard on the guard: if `noVary` ever stopped deleting, these cases would carry
    // the TypeScript defaults explicitly and Python would read them off the fixture
    // instead of falling back — which is exactly the blind spot they exist to close.
    const bare = actual.cases.filter((c) => c.name.startsWith('no vary keys')
      || c.name.startsWith('colour on with no')
      || c.name.startsWith('falloff with no')
      || c.name.startsWith('random with no'))
    expect(bare).toHaveLength(4)
    const declared = new Set(bare.flatMap((c) => Object.keys(c.cloner)))
    // Only the keys each case names on purpose survive; every other vary key is gone.
    expect([...declared].filter((k) => k.startsWith('vary')).sort())
      .toEqual(['varyColor', 'varyMode'])
    // …and the defaults really do reach the output, so a changed default moves numbers.
    expect(bare[1]!.expected.some((t) => t.tint !== null)).toBe(true)
  })

  it('covers a case with no vary at all, so the fixture also pins the zero-change path', () => {
    const plain = actual.cases.find((c) => c.name === 'linear, no vary')!
    expect(plain.expected.map((t) => t.dscale)).toEqual([0.25, 0.5, 1])
    expect(plain.expected.every((t) => t.tint === null)).toBe(true)
  })
})
