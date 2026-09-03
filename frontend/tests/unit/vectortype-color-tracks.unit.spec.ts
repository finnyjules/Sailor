/**
 * Vector Type — COLOUR MOTION TRACKS.
 *
 * The named gap: `MotionTrack.from`/`to` are numbers and `trackValue` returns a
 * number, so until now there was no path from a track to a fill. That single
 * absence blocked colour cycling, animated gradient stops, and it is the reason
 * the KineticType migration dropped `color-cycle` with the words *"tracks carry
 * numbers, not colours"*.
 *
 * Seven things are measured here, ordered by how easy each would be to fake:
 *
 *  1. **The INTERPOLATION SPACE, against an RGB control.** Not "we chose OKLab" —
 *     the midpoint of red → blue in each space, with its measured lightness and
 *     chroma, so the reason RGB is not the default is a number. The sRGB midpoint
 *     lands BELOW BOTH ENDPOINTS in lightness (L* 0.421 against 0.628 / 0.452) —
 *     the animation visibly dies in the middle. Both perceptual spaces stay
 *     inside the envelope.
 *  2. **A colour track really drives a leaf**, at the endpoints AND at four
 *     points in between, through the real `applyMotion` — and the intermediates
 *     are asserted to be neither endpoint, because a track that snapped at the
 *     half-way mark would pass an endpoints-only test.
 *  3. **The timing engine is the SAME one.** `trackValue`'s numbers are
 *     unchanged by the `trackProgress` extraction (a golden table computed
 *     independently), and a colour track's progress honours easing, loops, hold,
 *     cycleOffset and delay identically to a numeric one — asserted by driving
 *     both from the same timing fields and comparing.
 *  4. **CANVAS AND SVG AGREE EXACTLY** — the recorded `fillStyle` against the
 *     exported `fill` attribute, at nine times, with a broken control (the
 *     exporter reading the UNANIMATED config, which is what a second
 *     `applyMotion` call site would have caused) that disagrees on 8 of 9.
 *  5. **REAL PIXELS.** resvg rasterises the export: the ink's actual colour
 *     tracks the mix, and the ink MASK is byte-identical at every time — a colour
 *     animation must not move one pixel of geometry. Ink XOR carried alongside,
 *     because a mean-colour metric is blind to geometry (and vice versa).
 *  6. **The targets are DERIVED, not listed.** From the same `VT_CONTROLS`
 *     `kind: 'color'` rows the inspector reads, with the same `when` gates — so
 *     `paint.b` is not offered on a solid fill and neither colour is offered on a
 *     shader fill, where nothing would paint it.
 *  7. **The schema round-trips**, junk colours are REJECTED rather than clamped
 *     to black, and `VT_TRACK_IS_GRADIENT_COMPATIBLE` still holds — which is what
 *     keeps Gradient Studio and Scene3D on the one shared easing engine.
 *
 * Plus the two consumers the gap unblocked: the studio's Colour Cycle tile, and
 * `color-cycle` crossing the KineticType migration for the first time.
 *
 * NO NETWORK: the same eight-character Inter variable subset every other Vector
 * Type spec uses. NO DOM beyond a recording 2D context.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { Resvg } from '@resvg/resvg-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hexToOklch, oklchToHex, parseHexA } from '~/lib/color/convert'
import { COLOR_MIX_SPACES, DEFAULT_COLOR_MIX_SPACE, isColorMixSpace, mixHex } from '~/lib/color/mix'
import { trackProgress, trackValue } from '~/lib/studio/track'
import { trackValueAt } from '~/lib/studio/moves/tracks'
import type { MoveEase, MovePlay } from '~/lib/studio/moves/types'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  DEFAULT_FILL,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import {
  applyMotion,
  colorTargets,
  glyphStackLeaf,
  glyphTransform,
  isColorTargetPath,
  isColorTrack,
  trackColor,
} from '~/lib/vectortype/motion'
import { drawVectorType, vectorTypeSVG } from '~/lib/vectortype/canvas'
import {
  vtApplyTrackPreset,
  vtOppositeHue,
  vtTrackPreset,
  vtTrackPresetActive,
  vtTrackPresetOffer,
} from '~/lib/vectortype/trackPresets'
import { kineticParamsToVectorType, presetFidelity } from '~/lib/vectortype/migrateKinetic'

// Real rasters, a dozen of them, do not fit the suite's 5 s default while the
// whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const WORD = 'Sail'
const BOX = { width: 400, height: 200 }
const RED = '#ff0000'
const BLUE = '#0000ff'
const DURATION = 4

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}
function stack(...layers: Partial<VtAppearanceLayer>[]): VectorTypeConfig {
  return cfg({ appearance: layers.map((l, i) => vtLayer({ id: `L${i}`, ...l })) })
}

/** A track "spec" in the OLD shape — `easing`/`loops` moved onto the owning
 *  MOVE now (`trackMoves` below); this is the test-local DSL that still
 *  names them, for either a numeric or a colour track. */
interface TrackSpec {
  path: string
  from: number
  to: number
  fromColor?: string
  toColor?: string
  space?: string
  easing: 'linear' | 'pingpong' | 'easeinout'
  loops: number
  hold: number
  cycleOffset: number
  delay: number
}

/** A colour track spec with this studio's own defaults, spelled the way
 *  `mergeTrack` used to spell one: `from`/`to` are the 0..1 PROGRESS DOMAIN. */
function ctrack(path: string, fromColor: string, toColor: string, over: Partial<TrackSpec> = {}): TrackSpec {
  return {
    path, from: 0, to: 1, fromColor, toColor, space: DEFAULT_COLOR_MIX_SPACE,
    easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...over,
  }
}

/** `easing`/`loops` → the owning move's `ease`/`play` — the exact mapping
 *  `~/lib/studio/moves/merge`'s `legacyTrackEasePlay` uses for a legacy
 *  document, restated as this file's test-side DSL (see
 *  `vectortype-motion.unit.spec.ts`'s identical helper). */
function easeAndPlay(easing: 'linear' | 'pingpong' | 'easeinout', loops: number): { ease: MoveEase; play: MovePlay } {
  if (easing === 'pingpong') return { ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: loops } }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, play: { mode: 'once', times: loops } }
  return { ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: loops } }
}

let trackMoveSeq = 0
/** One `kind: 'tracks'` move per track spec — a track's cycle length is
 *  always the CLIP's duration (`applyMoveTracks` never reads a `'tracks'`
 *  move's own `duration`), so that field is a placeholder here. */
function trackMoves(specs: TrackSpec[]): VtMove[] {
  return specs.map((t) => {
    trackMoveSeq += 1
    const { ease, play } = easeAndPlay(t.easing, t.loops)
    const { path, from, to, hold, cycleOffset, delay, fromColor, toColor, space } = t
    return {
      id: `move-t${trackMoveSeq}`,
      phase: 'loop',
      kind: 'tracks',
      presetId: 'custom',
      duration: DURATION,
      ease,
      play,
      tracks: [{
        path, from, to, hold, cycleOffset, delay,
        ...(fromColor ? { fromColor } : {}),
        ...(toColor ? { toColor } : {}),
        ...(space ? { space } : {}),
      }],
    } as VtMove
  })
}

/** One solid fill layer whose colour a track drives, over a 4 s clip. */
function fillCfg(tracks: TrackSpec[], layer: Partial<VtAppearanceLayer> = {}): VectorTypeConfig {
  return mergeConfig({
    ...stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: RED }, ...layer }),
    motion: { ...DEFAULT_CONFIG.motion, duration: DURATION, moves: trackMoves(tracks) },
  })
}

const colorAt = (c: VectorTypeConfig, t: number): string => {
  const paint = applyMotion(c, t).appearance[0]!.paint as { a: string }
  return paint.a
}

/** Perceived lightness and chroma of a hex, so "murky" is two numbers. */
const LC = (hex: string): { L: number; C: number } => {
  const [L, C] = hexToOklch(parseHexA(hex).hex)
  return { L, C }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE INTERPOLATION SPACE — measured against the RGB control
// ════════════════════════════════════════════════════════════════════════════

describe('the interpolation space, against a naive RGB lerp', () => {
  it('the RGB midpoint of red → blue is DARKER THAN BOTH ENDPOINTS; the perceptual ones are not', () => {
    const mid = Object.fromEntries(COLOR_MIX_SPACES.map(s => [s, mixHex(RED, BLUE, 0.5, s)])) as Record<string, string>
    // Printed as the justification for the default, not as a footnote.
    const rows = COLOR_MIX_SPACES.map((s) => {
      const { L, C } = LC(mid[s]!)
      return { space: s, hex: mid[s]!, L: +L.toFixed(3), C: +C.toFixed(3) }
    })
    console.table(rows)

    const rgb = LC(mid.rgb!)
    const oklab = LC(mid.oklab!)
    const oklch = LC(mid.oklch!)
    const ends = [LC(RED), LC(BLUE)]

    // ── THE FAILURE: the sRGB lerp drops through a trough ────────────────────
    // Both endpoints are lighter than the RGB midpoint, so the animation visibly
    // dies in the middle and comes back.
    for (const e of ends) expect(rgb.L).toBeLessThan(e.L)
    // OKLab's midpoint sits BETWEEN the two endpoint lightnesses — no trough.
    const [lo, hi] = [Math.min(ends[0]!.L, ends[1]!.L), Math.max(ends[0]!.L, ends[1]!.L)]
    expect(oklab.L).toBeGreaterThanOrEqual(lo - 1e-9)
    expect(oklab.L).toBeLessThanOrEqual(hi + 1e-9)
    // …and it is meaningfully brighter than RGB's: >15 % of the L* range.
    expect(oklab.L - rgb.L).toBeGreaterThan(0.1)

    // ── What the two perceptual spaces trade, measured rather than assumed ──
    // OKLCH carries chroma all the way across (a hue ROTATION, not a chord), so
    // its midpoint is as colourful as the LESS colourful endpoint. OKLab is a
    // straight line through the a/b plane and therefore cuts the corner, giving
    // up chroma to keep lightness and to have no hue-wrap decision at all.
    //
    // Worth stating plainly because it contradicts the easy story: the sRGB
    // midpoint is NOT the greyest of the three (0.193 sits between OKLab's 0.133
    // and OKLCH's 0.260). Its failure is the DARKNESS above, and that is the one
    // that reads as the animation dying in the middle.
    expect(oklch.C).toBeGreaterThan(Math.min(ends[0]!.C, ends[1]!.C))
    expect(oklab.C).toBeLessThan(oklch.C)
    // Both perceptual spaces keep every step INSIDE the lightness envelope of the
    // two endpoints (allowing for the gamut clamp OKLCH needs); RGB does not.
    expect(oklch.L).toBeGreaterThan(lo - 0.05)
  })

  it('no space has a dark or grey hole ANYWHERE across the ramp, except rgb', () => {
    // The midpoint is the worst case but not the only one. Sampled across the
    // whole ramp: the perceptual spaces never dip below both endpoints.
    const floor = Math.min(LC(RED).L, LC(BLUE).L)
    for (const space of ['oklab', 'oklch'] as const) {
      for (let p = 0.05; p < 1; p += 0.05) {
        expect(LC(mixHex(RED, BLUE, p, space)).L, `${space} @ ${p.toFixed(2)}`)
          .toBeGreaterThan(floor - 1e-6)
      }
    }
    // The control genuinely fails this — otherwise the assertion above proves
    // nothing about the choice.
    let dips = 0
    for (let p = 0.05; p < 1; p += 0.05) if (LC(mixHex(RED, BLUE, p, 'rgb')).L < floor) dips++
    expect(dips).toBeGreaterThan(5)
  })

  it('is EXACT at both ends, in every space', () => {
    for (const space of COLOR_MIX_SPACES) {
      // Byte-exact, not close: frame 0 is the frame a still bake captures, and a
      // cbrt round-trip landing on #fe0000 would ship as "my red went off".
      expect(mixHex(RED, BLUE, 0, space), space).toBe(RED)
      expect(mixHex(RED, BLUE, 1, space), space).toBe(BLUE)
    }
  })

  it('is MONOTONE and continuous — no reversal, no jump', () => {
    // A hue-wrap bug shows up as a jump: two adjacent samples far apart in the
    // space they are being mixed in.
    for (const space of COLOR_MIX_SPACES) {
      let prev = LC(mixHex(RED, BLUE, 0, space))
      for (let p = 0.02; p <= 1.0001; p += 0.02) {
        const cur = LC(mixHex(RED, BLUE, p, space))
        expect(Math.abs(cur.L - prev.L), `${space} L jump @ ${p.toFixed(2)}`).toBeLessThan(0.05)
        prev = cur
      }
    }
  })

  it('takes the SHORT way round, and treats a grey hue as powerless', () => {
    // Red → blue the short way passes through magenta, never through green.
    for (let p = 0.1; p < 1; p += 0.1) {
      const [, , H] = hexToOklch(mixHex(RED, BLUE, p, 'oklch'))
      // Red is ~29°, blue is ~264°; the short arc runs backwards through 0/360.
      expect(H > 250 || H < 40, `hue ${H.toFixed(0)} @ ${p.toFixed(1)}`).toBe(true)
    }
    // Grey has no hue. Mixing grey → blue must be a chroma ramp at BLUE's hue,
    // not a sweep through every hue on the way from an accidental 0°.
    const blueH = hexToOklch(BLUE)[2]
    for (let p = 0.2; p < 1; p += 0.2) {
      const [, , H] = hexToOklch(mixHex('#808080', BLUE, p, 'oklch'))
      expect(Math.abs(H - blueH), `grey→blue hue @ ${p.toFixed(1)}`).toBeLessThan(1)
    }
  })

  it('mixes ALPHA linearly and emits the short form when opaque', () => {
    expect(mixHex('#ff000000', '#0000ffff', 0.5, 'oklab')).toMatch(/^#[0-9a-f]{6}80$/)
    // Both ends opaque → no alpha byte anywhere across the ramp, so a config that
    // never used alpha keeps producing 6-digit hex and its diffs stay small.
    for (let p = 0; p <= 1.0001; p += 0.1) {
      expect(mixHex(RED, BLUE, p, 'oklab')).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('never produces a colour a renderer cannot parse, from any input', () => {
    for (const junk of ['', '#', 'red', '#12', '#xyzxyz', 'rgb(1,2,3)', '#1234567']) {
      for (const space of COLOR_MIX_SPACES) {
        expect(mixHex(junk, BLUE, 0.5, space), `${junk} ${space}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
        expect(mixHex(RED, junk, 0.5, space), `${junk} ${space}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      }
    }
    // A non-finite or out-of-range progress clamps rather than producing NaN
    // channels, which reach canvas as an unparseable `fillStyle` and silently
    // paint the PREVIOUS layer's colour.
    for (const p of [NaN, Infinity, -Infinity, -3, 4]) {
      expect(mixHex(RED, BLUE, p as number, 'oklab')).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('rejects an unknown space name at the schema boundary', () => {
    for (const junk of ['lab', 'hsl', '', 'OKLAB', 42, null, undefined]) {
      expect(isColorMixSpace(junk), String(junk)).toBe(false)
    }
    for (const s of COLOR_MIX_SPACES) expect(isColorMixSpace(s)).toBe(true)
    expect(DEFAULT_COLOR_MIX_SPACE).toBe('oklab')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. A COLOUR TRACK DRIVES A LEAF — intermediates, not just endpoints
// ════════════════════════════════════════════════════════════════════════════

describe('applyMotion writes a COLOUR into the leaf a track names', () => {
  const c = () => fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE)])

  it('lands the two endpoints exactly, and something ALIVE in between', () => {
    const k = c()
    expect(colorAt(k, 0)).toBe(RED)
    expect(colorAt(k, DURATION)).toBe(BLUE)

    // THE INTERMEDIATES, which is the whole point: five sampled colours, each
    // distinct from both ends and from each other.
    const samples = [0.5, 1, 2, 3, 3.5].map(t => ({ t, hex: colorAt(k, t) }))
    console.table(samples.map(s => ({ ...s, ...LC(s.hex) })))
    for (const s of samples) {
      expect(s.hex, `t=${s.t}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(s.hex, `t=${s.t}`).not.toBe(RED)
      expect(s.hex, `t=${s.t}`).not.toBe(BLUE)
    }
    expect(new Set(samples.map(s => s.hex)).size).toBe(samples.length)

    // …and they walk from red to blue rather than jumping: red channel falls,
    // blue channel rises, monotonically, at every step.
    const rgbOf = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
    const walk = [0, 0.5, 1, 2, 3, 3.5, DURATION].map(t => rgbOf(colorAt(k, t)))
    for (let i = 1; i < walk.length; i++) {
      expect(walk[i]![0], `red @ step ${i}`).toBeLessThan(walk[i - 1]![0]!)
      expect(walk[i]![2], `blue @ step ${i}`).toBeGreaterThan(walk[i - 1]![2]!)
    }
  })

  it('the MIDPOINT is alive in OKLab and murky in RGB — the same track, one field changed', () => {
    const perceptual = colorAt(fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE, { space: 'oklab' })]), 2)
    const naive = colorAt(fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE, { space: 'rgb' })]), 2)
    console.log('midpoint  oklab', perceptual, LC(perceptual), '   rgb', naive, LC(naive))
    expect(perceptual).not.toBe(naive)
    expect(LC(perceptual).L).toBeGreaterThan(LC(naive).L + 0.1)
  })

  it('DOES NOT MUTATE the config it was given', () => {
    const k = c()
    const before = structuredClone(k)
    for (const t of [0, 0.7, 2, 3.9, 4]) applyMotion(k, t)
    expect(k).toEqual(before)
  })

  it('drives a gradient STOP, and the OTHER stop independently', () => {
    const k = mergeConfig({
      ...stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, type: 'gradient', a: RED, b: '#00ff00' } }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: DURATION,
        moves: trackMoves([
          ctrack('appearance.Lfill.paint.a', RED, BLUE),
          ctrack('appearance.Lfill.paint.b', '#00ff00', '#ffff00'),
        ]),
      },
    })
    const mid = applyMotion(k, 2).appearance[0]!.paint as { a: string; b: string }
    expect(mid.a).not.toBe(RED)
    expect(mid.b).not.toBe('#00ff00')
    expect(mid.a).not.toBe(mid.b)
    const end = applyMotion(k, DURATION).appearance[0]!.paint as { a: string; b: string }
    expect([end.a, end.b]).toEqual([BLUE, '#ffff00'])
  })

  it('IGNORES a colour track whose layer is gone — never re-aims it at a neighbour', () => {
    const k = mergeConfig({
      ...stack({ id: 'Lkeep', kind: 'fill', paint: { ...DEFAULT_FILL, a: '#123456' } }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: DURATION,
        moves: trackMoves([ctrack('appearance.Lgone.paint.a', RED, BLUE)]),
      },
    })
    // The surviving layer keeps its own colour at every time. A positional
    // fallback would have painted it red→blue.
    for (const t of [0, 1, 2, 4]) {
      expect((applyMotion(k, t).appearance[0]!.paint as { a: string }).a, `t=${t}`).toBe('#123456')
    }
  })

  it('LAST TRACK WINS on one path, exactly as a numeric pair does', () => {
    const k = fillCfg([
      ctrack('appearance.Lfill.paint.a', RED, '#00ff00'),
      ctrack('appearance.Lfill.paint.a', RED, BLUE),
    ])
    expect(colorAt(k, DURATION)).toBe(BLUE)
  })

  it('composes with a NUMERIC track on the same layer', () => {
    const k = fillCfg(
      [
        ctrack('appearance.Lfill.paint.a', RED, BLUE),
        { path: 'appearance.Lfill.opacity', from: 1, to: 0.25, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 } as TrackSpec,
      ],
      { opacity: 1 },
    )
    const out = applyMotion(k, DURATION)
    expect((out.appearance[0]!.paint as { a: string }).a).toBe(BLUE)
    expect(out.appearance[0]!.opacity).toBeCloseTo(0.25, 6)
  })

  it('a colour track cannot corrupt a NUMERIC channel', () => {
    // Hand-written / agent-written: a colour track aimed at the glyph namespace
    // and at a stack leaf that both expect numbers. `NaN` in `scale` makes the
    // CTM singular and Chrome drops the glyph entirely, so this must be skipped
    // rather than coerced.
    const k = mergeConfig({
      ...stack({ id: 'Lstroke', kind: 'stroke', width: 6 }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: DURATION,
        stagger: { delay: 0.4, order: 'forward', seed: 0 },
        moves: trackMoves([
          ctrack('glyph.scale', RED, BLUE),
          ctrack('appearance.Lstroke.draw', RED, BLUE),
        ]),
      },
    })
    for (const t of [0, 1, 2, 4]) {
      const g = glyphTransform(k, t, 1, 4)
      for (const [key, v] of Object.entries(g)) expect(Number.isFinite(v), `${key} @ ${t}`).toBe(true)
      expect(g.scale, `scale @ ${t}`).toBe(1)
      // The staggered draw-on leaf falls back to the value the caller resolved.
      expect(glyphStackLeaf(k, 'Lstroke', 'draw', 0.75, t, 1, 4)).toBe(0.75)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. THE SAME TIMING ENGINE — and `trackValue` is unchanged by the split
// ════════════════════════════════════════════════════════════════════════════

describe('the shared timing engine — extracted, not changed', () => {
  /** Every timing shape that matters, so the golden table below is not just the
   *  easy case. `trackProgress`/`trackValue` (`~/lib/studio/track`) are the
   *  SHARED, studio-agnostic timing primitives, unaffected by the moves
   *  redesign — they know nothing about Vector Type's own storage shape,
   *  only about `{from,to,easing,loops,hold,cycleOffset,delay}`, so these two
   *  hand-built shapes are legitimate direct inputs, not a stand-in for a
   *  real stored track. */
  interface LegacyShape { easing: 'linear' | 'pingpong' | 'easeinout'; loops?: number; hold?: number; cycleOffset?: number; delay?: number }
  const SHAPES: LegacyShape[] = [
    { easing: 'linear' },
    { easing: 'easeinout' },
    { easing: 'pingpong' },
    { easing: 'linear', loops: 3 },
    { easing: 'pingpong', loops: 2, hold: 0.25 },
    { easing: 'linear', cycleOffset: 0.3, loops: 2 },
    { easing: 'easeinout', delay: 1 },
    { easing: 'pingpong', loops: 2, hold: 0.4, cycleOffset: 0.7, delay: 0.5 },
  ]
  const TIMES = [0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.75, 4, 5]

  it('trackValue is EXACTLY from + (to − from) · trackProgress, on every shape', () => {
    // The refactor's whole risk is that `trackValue` moved. Asserted against an
    // independent reimplementation of the identity rather than against a snapshot
    // of the function's own output.
    for (const shape of SHAPES) {
      const tk = { path: 'size', from: 100, to: 900, loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...shape }
      for (const t of TIMES) {
        const p = trackProgress(tk, t, DURATION)
        expect(p, `${JSON.stringify(shape)} @ ${t}`).toBeGreaterThanOrEqual(0)
        expect(p, `${JSON.stringify(shape)} @ ${t}`).toBeLessThanOrEqual(1)
        expect(trackValue(tk, t, DURATION), `${JSON.stringify(shape)} @ ${t}`)
          .toBeCloseTo(100 + 800 * p, 12)
      }
    }
  })

  it('trackValue still returns `from` before its delay, and `trackProgress` returns 0', () => {
    const tk = { path: 'size', from: 100, to: 900, easing: 'linear' as const, loops: 1, hold: 0, cycleOffset: 0, delay: 2 }
    expect(trackValue(tk, 0, DURATION)).toBe(100)
    expect(trackValue(tk, 1.99, DURATION)).toBe(100)
    expect(trackProgress(tk, 0, DURATION)).toBe(0)
  })

  it('a COLOUR track honours every timing knob identically to a numeric one', () => {
    // A track's timing is now the OWNING MOVE's `ease`/`play` (Task 5), so
    // "one engine, not two" is now proved by driving BOTH a numeric and a
    // colour track through the SAME real production functions —
    // `trackValueAt`/`trackColor` (`~/lib/studio/moves/tracks`,
    // `~/lib/vectortype/motion`) — tagged with the SAME `__ease`/`__play`,
    // rather than comparing against the old, now-parallel `trackValue`
    // engine (which no longer shares a timing vocabulary with a stored
    // track: `easing: 'easeinout'` mapped to a literal quadratic curve there,
    // and now maps to the ten-name `'natural'`/sine.inOut — a deliberate,
    // different curve in the same family, not a preserved one).
    for (const shape of SHAPES) {
      const { ease, play } = easeAndPlay(shape.easing, shape.loops ?? 1)
      const timing = { hold: shape.hold ?? 0, cycleOffset: shape.cycleOffset ?? 0, delay: shape.delay ?? 0 }
      const numeric = { path: 'size', from: 0, to: 1, ...timing, __ease: ease, __play: play }
      const colour = { path: 'appearance.Lfill.paint.a', from: 0, to: 1, fromColor: RED, toColor: BLUE, ...timing, __ease: ease, __play: play }
      for (const t of TIMES) {
        // The colour a track shows at `t` is exactly the mix at the numeric
        // track's own value at `t` — one engine, proved by equality.
        expect(trackColor(colour, t, DURATION), `${JSON.stringify(shape)} @ ${t}`)
          .toBe(mixHex(RED, BLUE, trackValueAt(numeric, t, DURATION), 'oklab'))
      }
    }
  })

  it('a PINGPONG colour track returns to its start — so an exported loop does not cut', () => {
    const k = fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE, { easing: 'pingpong' })])
    expect(colorAt(k, 0)).toBe(RED)
    expect(colorAt(k, DURATION)).toBe(RED)
    expect(colorAt(k, DURATION / 2)).toBe(BLUE)
  })

  it('a DELAYED colour track holds its start colour, then moves', () => {
    const k = fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE, { delay: 2 })])
    expect(colorAt(k, 0)).toBe(RED)
    expect(colorAt(k, 1.9)).toBe(RED)
    expect(colorAt(k, 3)).not.toBe(RED)
    expect(colorAt(k, 6)).toBe(BLUE)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. CANVAS AND SVG AGREE
// ════════════════════════════════════════════════════════════════════════════

type Mat = [number, number, number, number, number, number]

class FakeMatrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  static from(m: Mat) { return new FakeMatrix(...m) }
  get mat(): Mat { return [this.a, this.b, this.c, this.d, this.e, this.f] }
  multiply(o: FakeMatrix): FakeMatrix {
    return new FakeMatrix(
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    )
  }
  translate(x: number, y: number) { return this.multiply(new FakeMatrix(1, 0, 0, 1, x, y)) }
  inverse() { return new FakeMatrix() }
}
class FakePath2D { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {} }

/** Records the STYLE of every paint, which is all this section needs. */
class RecCtx {
  styles: unknown[] = []
  private m: Mat = [1, 0, 0, 1, 0, 0]
  private stack: Mat[] = []
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  filter = 'none'
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 0
  lineJoin = ''
  getTransform() { return FakeMatrix.from(this.m) }
  setTransform(...a: unknown[]) {
    if (a.length === 1 && a[0] instanceof FakeMatrix) this.m = (a[0] as FakeMatrix).mat
    else this.m = (a as number[]).slice(0, 6) as Mat
  }
  save() { this.stack.push([...this.m] as Mat) }
  restore() { const s = this.stack.pop(); if (s) this.m = s }
  translate(x: number, y: number) { this.m = FakeMatrix.from(this.m).translate(x, y).mat }
  rotate() {}
  scale() {}
  clearRect() {} fillRect() {} beginPath() {} rect() {} clip() {}
  setLineDash() {}
  createLinearGradient() { return { addColorStop() {} } }
  createRadialGradient() { return { addColorStop() {} } }
  createPattern() { return null }
  fill() { this.styles.push(this.fillStyle) }
  stroke() { this.styles.push(this.strokeStyle) }
}

let hadPath2D: unknown
let hadDOMMatrix: unknown
beforeAll(() => {
  hadPath2D = (globalThis as any).Path2D
  hadDOMMatrix = (globalThis as any).DOMMatrix
  ;(globalThis as any).Path2D = FakePath2D
  ;(globalThis as any).DOMMatrix = FakeMatrix
})
afterAll(() => {
  ;(globalThis as any).Path2D = hadPath2D
  ;(globalThis as any).DOMMatrix = hadDOMMatrix
})

/** The one distinct colour the canvas painted with, at time `t`. */
function canvasColor(c: VectorTypeConfig, t: number): string {
  const ctx = new RecCtx()
  drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, { ...BOX })
  const uniq = [...new Set(ctx.styles.map(String))]
  expect(uniq, `t=${t}`).toHaveLength(1)
  return uniq[0]!
}

/** The one distinct `fill` attribute the export wrote, at time `t`. */
function svgColor(c: VectorTypeConfig, t: number): string {
  const svg = vectorTypeSVG(font, c, t, BOX).svg
  const fills = [...svg.matchAll(/<path\b[^>]*\sfill="([^"]*)"/g)].map(m => m[1] as string)
  const uniq = [...new Set(fills)]
  expect(uniq, `t=${t}`).toHaveLength(1)
  return uniq[0]!
}

const TIMES_9 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]

describe('canvas and SVG agree on an animated colour', () => {
  const k = () => fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE)])

  it('paints the IDENTICAL colour at every time — 0.0000 % disagreement', () => {
    const c = k()
    const rows = TIMES_9.map(t => ({ t, canvas: canvasColor(c, t), svg: svgColor(c, t) }))
    console.table(rows)
    const differing = rows.filter(r => r.canvas !== r.svg).length
    expect(`${((differing / rows.length) * 100).toFixed(4)} %`).toBe('0.0000 %')
    // …and the colour genuinely MOVED across those nine samples, so agreeing on
    // one frozen colour nine times could not have passed this.
    expect(new Set(rows.map(r => r.canvas)).size).toBe(rows.length)
  })

  it('the BROKEN CONTROL disagrees on 8 of 9', () => {
    // The bug this measurement exists to catch: an exporter that resolved its
    // paint from the config it was handed instead of from the post-`applyMotion`
    // frame. Simulated by asking the export for t = 0 while the canvas advances.
    const c = k()
    const rows = TIMES_9.map(t => ({ t, canvas: canvasColor(c, t), svgBroken: svgColor(c, 0) }))
    const differing = rows.filter(r => r.canvas !== r.svgBroken).length
    expect(differing).toBe(8)
    expect(`${((differing / rows.length) * 100).toFixed(4)} %`).toBe('88.8889 %')
  })

  it('agrees on a STROKE layer’s colour too — the `stroke` attribute, not `fill`', () => {
    // A different write path in both renderers: canvas sets `strokeStyle` and the
    // exporter writes a `stroke=` attribute, so a colour that reached one and not
    // the other would show up here and nowhere above.
    const c = mergeConfig({
      ...stack({ id: 'Lstroke', kind: 'stroke', width: 8, paint: { ...DEFAULT_FILL, a: RED } }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: DURATION,
        moves: trackMoves([ctrack('appearance.Lstroke.paint.a', RED, BLUE)]),
      },
    })
    for (const t of TIMES_9) {
      const svg = vectorTypeSVG(font, c, t, BOX).svg
      const strokes = [...new Set([...svg.matchAll(/\sstroke="([^"]*)"/g)].map(m => m[1] as string))]
      expect(strokes, `t=${t}`).toEqual([mixHex(RED, BLUE, t / DURATION, 'oklab')])
      // …and the canvas painted the identical colour with `strokeStyle`.
      expect(canvasColor(c, t), `t=${t}`).toBe(strokes[0])
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. REAL PIXELS — the ink's colour moves and its GEOMETRY does not
// ════════════════════════════════════════════════════════════════════════════

interface Raster { mask: Uint8Array; n: number; mode: string }

/** Rasterise the export and report the ink mask plus its modal colour. */
function raster(svg: string): Raster {
  const img = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
  const px = img.pixels
  const total = img.width * img.height
  const mask = new Uint8Array(total)
  const tally = new Map<string, number>()
  let n = 0
  for (let i = 0; i < total; i++) {
    // Fully opaque only: the antialiased fringe is a blend with the background
    // and would drag the modal colour around.
    if (px[i * 4 + 3]! < 255) continue
    mask[i] = 1
    n++
    const hex = `#${[0, 1, 2].map(o => px[i * 4 + o]!.toString(16).padStart(2, '0')).join('')}`
    tally.set(hex, (tally.get(hex) ?? 0) + 1)
  }
  let mode = ''
  let best = 0
  for (const [hex, c] of tally) if (c > best) { best = c; mode = hex }
  return { mask, n, mode }
}

/** Symmetric difference over union — the geometry metric a colour metric is
 *  blind to. Two frames can be the same colour and share no ink at all. */
function inkXor(a: Raster, b: Raster): number {
  let diff = 0
  let union = 0
  for (let i = 0; i < a.mask.length; i++) {
    const x = a.mask[i]!, y = b.mask[i]!
    if (x !== y) diff++
    if (x || y) union++
  }
  return union ? diff / union : 0
}

describe('the rasterised ink really changes colour, and nothing else', () => {
  const k = () => fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE)])

  it('the PIXELS carry the mixed colour, and the ink MASK never moves', () => {
    const c = k()
    const frames = TIMES_9.map(t => ({ t, r: raster(vectorTypeSVG(font, c, t, BOX).svg) }))
    console.table(frames.map(f => ({
      t: f.t, expected: mixHex(RED, BLUE, f.t / DURATION, 'oklab'), rendered: f.r.mode, inkPx: f.r.n,
    })))
    for (const f of frames) {
      expect(f.r.n, `t=${f.t}`).toBeGreaterThan(2000)
      expect(f.r.mode, `t=${f.t}`).toBe(mixHex(RED, BLUE, f.t / DURATION, 'oklab'))
    }
    // GEOMETRY UNCHANGED — the second metric. A colour track that also nudged
    // the letterforms would pass every colour assertion above.
    const first = frames[0]!.r
    for (const f of frames.slice(1)) expect(inkXor(first, f.r), `t=${f.t}`).toBe(0)
    // …and the colours really are all different, so "the mask never moves" is
    // not the trivial consequence of nothing happening.
    expect(new Set(frames.map(f => f.r.mode)).size).toBe(frames.length)
  })

  it('the BROKEN CONTROL — the same clip with the track removed — is one flat colour', () => {
    const dead = fillCfg([])
    const modes = TIMES_9.map(t => raster(vectorTypeSVG(font, dead, t, BOX).svg).mode)
    expect(new Set(modes).size).toBe(1)
    expect(modes[0]).toBe(RED)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. THE TARGETS ARE DERIVED FROM THE ONE DECLARATION
// ════════════════════════════════════════════════════════════════════════════

describe('colorTargets — derived from VT_CONTROLS, gated per layer', () => {
  it('offers each fill layer its own colour, addressed BY ID', () => {
    const c = stack(
      { id: 'La', kind: 'fill' },
      { id: 'Lb', kind: 'fill', paint: { ...DEFAULT_FILL, type: 'gradient' } },
    )
    const paths = colorTargets(c).map(t => t.path)
    expect(paths).toContain('appearance.La.paint.a')
    expect(paths).toContain('appearance.Lb.paint.a')
    // The second stop is offered only where it PAINTS — a solid fill's `b` is
    // never read, and a control that resolves to nothing is a dead one.
    expect(paths).toContain('appearance.Lb.paint.b')
    expect(paths).not.toContain('appearance.La.paint.b')
    // Nothing relative survives: `applyMotion` has no `layer` key to resolve.
    expect(paths.some(p => p.startsWith('layer.'))).toBe(false)
  })

  it('offers NOTHING on a SHADER fill — its own `a` is never painted', () => {
    const c = stack({
      id: 'Lsh',
      kind: 'fill',
      paint: { ...DEFAULT_FILL, type: 'shader', shader: { effectId: 'noise', params: {}, input: RED } } as any,
    })
    expect(colorTargets(c).some(t => t.path.startsWith('appearance.Lsh.paint'))).toBe(false)
  })

  it('offers a SOLID EXTRUDE its silhouette colour, and no other kind', () => {
    const c = stack(
      { id: 'Lsolid', kind: 'extrude', depth: 4, solid: true },
      { id: 'Lloose', kind: 'extrude', depth: 4, solid: false },
      { id: 'Lstroke', kind: 'stroke', width: 4 },
    )
    const paths = colorTargets(c).map(t => t.path)
    expect(paths).toContain('appearance.Lsolid.strokeColor')
    expect(paths).not.toContain('appearance.Lloose.strokeColor')
    expect(paths).not.toContain('appearance.Lstroke.strokeColor')
  })

  it('offers nothing from the stack when the stack is empty', () => {
    expect(colorTargets(cfg({ appearance: [] }))).toEqual([])
  })

  it('names each target with the layer it belongs to, uniquely', () => {
    const c = stack({ id: 'L1', kind: 'fill' }, { id: 'L2', kind: 'fill' }, { id: 'L3', kind: 'fill' })
    const targets = colorTargets(c)
    expect(targets.map(t => t.label)).toEqual(['Fill · Fill', 'Fill 2 · Fill', 'Fill 3 · Fill'])
    expect(new Set(targets.map(t => t.label)).size).toBe(targets.length)
    for (const t of targets) expect(t.group).toBeTruthy()
  })

  it('every offered path RESOLVES to a colour string on the live config', () => {
    // The test that catches a target nothing reads. Not "the path looks right" —
    // read it back off the config and check it is a colour.
    const c = mergeConfig({
      ...stack(
        { id: 'La', kind: 'fill', paint: { ...DEFAULT_FILL, type: 'gradient' } },
        { id: 'Lb', kind: 'extrude', depth: 4, solid: true },
        { id: 'Lc', kind: 'stroke', width: 3 },
      ),
    })
    expect(colorTargets(c).length).toBeGreaterThan(2)
    for (const t of colorTargets(c)) {
      const written = applyMotion(mergeConfig({
        ...c,
        motion: { ...DEFAULT_CONFIG.motion, duration: DURATION, moves: trackMoves([ctrack(t.path, RED, BLUE)]) },
      }), DURATION)
      const segs = t.path.split('.')
      const layer = written.appearance.find(l => l.id === segs[1])!
      const value = segs.length === 3
        ? (layer as any)[segs[2]!]
        : (layer.paint as any)[segs[3]!]
      expect(value, t.path).toBe(BLUE)
    }
  })

  it('never emits a member segment that could be read as an index', () => {
    const c = mergeConfig({ ...DEFAULT_CONFIG, appearance: [{ kind: 'fill' }, { kind: 'fill' }] as any })
    for (const t of colorTargets(c)) expect(t.path.split('.')[1], t.path).not.toMatch(/^\d+$/)
  })

  it('isColorTargetPath answers for the row, and says no to a numeric leaf', () => {
    const c = stack({ id: 'La', kind: 'fill' }, { id: 'Lb', kind: 'stroke', width: 4 })
    expect(isColorTargetPath(c, 'appearance.La.paint.a')).toBe(true)
    expect(isColorTargetPath(c, ' appearance.La.paint.a ')).toBe(true)
    expect(isColorTargetPath(c, 'appearance.Lb.width')).toBe(false)
    expect(isColorTargetPath(c, 'axes.wght')).toBe(false)
    expect(isColorTargetPath(c, '')).toBe(false)
  })

  it('isColorTrack asks the TRACK, not the path — so a stack edit cannot unmake one', () => {
    expect(isColorTrack(ctrack('appearance.La.paint.a', RED, BLUE))).toBe(true)
    expect(isColorTrack(ctrack('appearance.La.paint.a', RED, '#ffffffcc'))).toBe(true)
    expect(isColorTrack({ path: 'size', from: 0, to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })).toBe(false)
    // Half a colour track is not a colour track: falling through to the numeric
    // branch is recoverable, writing `undefined` into a fill is not.
    expect(isColorTrack({ ...ctrack('appearance.La.paint.a', RED, BLUE), toColor: undefined })).toBe(false)
    expect(isColorTrack({ ...ctrack('appearance.La.paint.a', RED, BLUE), fromColor: 'red' })).toBe(false)
    expect(isColorTrack(null)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. THE SCHEMA, AND THE SHARED-ENGINE GUARD
// ════════════════════════════════════════════════════════════════════════════

describe('the stored shape', () => {
  // `load` puts raw tracks straight inside one `'tracks'`-kind move — the
  // per-TRACK merge (`mergeTrack` in config.ts, the function every one of
  // these tests is really about) runs identically whether the move around it
  // is well-formed or minimal, since `mergeMove` defaults everything else.
  const load = (tracks: unknown[]): VtMotionTrack[] => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG, motion: { ...DEFAULT_CONFIG.motion, moves: [{ kind: 'tracks', tracks }] } as any })
    const mv = merged.motion.moves.find(m => m.kind === 'tracks')
    return (mv?.tracks ?? []) as VtMotionTrack[]
  }

  /** A raw TRACK (not a `ctrack` "spec" — no `easing`/`loops`, which are the
   *  owning MOVE's now, not stored on the track at all). */
  const rawTrack = (path: string, fromColor: string, toColor: string, over: Partial<VtMotionTrack> = {}): VtMotionTrack =>
    ({ path, from: 0, to: 1, fromColor, toColor, space: DEFAULT_COLOR_MIX_SPACE, hold: 0, cycleOffset: 0, delay: 0, ...over })

  it('round-trips a colour track through mergeConfig unchanged', () => {
    const t = rawTrack('appearance.L0.paint.a', RED, BLUE, { hold: 0.1, cycleOffset: 0.25, delay: 0.5, space: 'oklch' })
    expect(load([t])[0]).toEqual(t)
    // …and a second pass is a fixed point, which is what a save/load cycle is.
    expect(load(load([t]))[0]).toEqual(t)
  })

  it('normalises the colour spelling — short form, upper case, alpha', () => {
    const [a] = load([{ ...rawTrack('size', '#F00', '#00FF00CC') }])
    expect(a!.fromColor).toBe('#ff0000')
    expect(a!.toColor).toBe('#00ff00cc')
  })

  it('REJECTS a junk colour rather than clamping it to black', () => {
    // `clampHex` would have made this `#000000`, and the fill would animate to
    // black — which reads as a rendering bug rather than as a bad value.
    for (const junk of ['red', '', '#12', 'rgb(0,0,0)', 42, null, {}]) {
      const [t] = load([{ ...rawTrack('appearance.L0.paint.a', RED, BLUE), toColor: junk }])
      expect(t!.fromColor, String(junk)).toBeUndefined()
      expect(t!.toColor, String(junk)).toBeUndefined()
      expect(t!.space, String(junk)).toBeUndefined()
      // Still a valid NUMERIC track — nothing is dropped from the timeline.
      expect(t!.path).toBe('appearance.L0.paint.a')
    }
  })

  it('writes ALL THREE colour fields or NONE — never a half state', () => {
    const [half] = load([{ path: 'size', from: 0, to: 1, fromColor: RED }])
    expect(half!.fromColor).toBeUndefined()
    expect(half!.toColor).toBeUndefined()
    expect(half!.space).toBeUndefined()
    const [full] = load([{ path: 'size', from: 0, to: 1, fromColor: RED, toColor: BLUE }])
    expect(full!.space).toBe(DEFAULT_COLOR_MIX_SPACE)
  })

  it('falls back on an unknown space rather than passing it to a renderer', () => {
    const [t] = load([{ ...rawTrack('size', RED, BLUE), space: 'cielab' }])
    expect(t!.space).toBe(DEFAULT_COLOR_MIX_SPACE)
  })

  it('leaves a NUMERIC track free of colour fields — and free of the retired easing/loops, now the owning move\'s job', () => {
    const numeric = { path: 'axes.wght', from: 100, to: 900, hold: 0.1, cycleOffset: 0.2, delay: 0.3 }
    expect(load([numeric])[0]).toEqual(numeric)
    expect(Object.keys(load([numeric])[0]!).sort())
      .toEqual(['cycleOffset', 'delay', 'from', 'hold', 'path', 'to'])
  })

  it('cloneConfig carries the colour fields, and shares nothing', () => {
    const k = fillCfg([ctrack('appearance.Lfill.paint.a', RED, BLUE)])
    const frame = applyMotion(k, 2)
    const frameTrack = frame.motion.moves.find(m => m.kind === 'tracks')!.tracks![0]!
    expect(frameTrack.fromColor).toBe(RED)
    frameTrack.toColor = '#00ff00'
    const sourceTrack = k.motion.moves.find(m => m.kind === 'tracks')!.tracks![0]!
    expect(sourceTrack.toColor).toBe(BLUE)
  })

  // `VT_TRACK_IS_GRADIENT_COMPATIBLE` — the compile-time structural proof that
  // a VT colour track satisfies the SAME `TrackTiming` the Gradient/Scene3D
  // engine reads — no longer exists (config.ts's own header: "the two
  // vocabularies diverged on purpose the moment ease/play moved onto the
  // move, so that compile-time proof would now fail by design rather than by
  // drift, and was removed rather than kept red"). A stored `VtMotionTrack`
  // genuinely no longer carries `easing`/`loops` at all, so it is no longer
  // assignable to `TrackTiming` — correctly, since its timing now lives on
  // the owning Move. Nothing here replaces the assertion; the invariant it
  // protected does not hold any more, on purpose.
})

// ════════════════════════════════════════════════════════════════════════════
// 8. THE TWO CONSUMERS THE GAP BLOCKED
// ════════════════════════════════════════════════════════════════════════════

describe('the Colour Cycle track preset', () => {
  const preset = () => vtTrackPreset('colour-cycle')!

  it('is offered on a coloured fill layer and writes ONE colour track', () => {
    const c = stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: RED } })
    expect(vtTrackPresetOffer(preset(), c).available).toBe(true)
    const moves = vtApplyTrackPreset(c, 'colour-cycle')
    expect(moves).toHaveLength(1)
    const mv = moves[0]!
    expect(mv.tracks).toHaveLength(1)
    const t = mv.tracks![0]!
    expect(t.path).toBe('appearance.Lfill.paint.a')
    expect(t.fromColor).toBe(RED)
    // PING-PONG — `ease: none`, `play: backAndForth`, the preset's own fixed
    // timing (see `trackPresets.ts`'s `colour-cycle` entry).
    expect(mv.ease).toEqual({ kind: 'named', name: 'none' })
    expect(mv.play.mode).toBe('backAndForth')
    // A hue ROTATION, so OKLCH — not the track default. In OKLab this exact pair
    // is a straight line through the middle of the a/b plane, i.e. through grey.
    expect(t.space).toBe('oklch')
    // The far end is the OPPOSITE HUE at the same lightness. `vtOppositeHue`
    // reduces CHROMA to stay in gamut rather than letting a per-channel clamp
    // eat the rotation, so the hue is exact and the lightness is preserved.
    const from = hexToOklch(RED)
    const to = hexToOklch(t.toColor!)
    expect(to[0]).toBeCloseTo(from[0], 2)
    expect(Math.abs(((to[2] - from[2]) % 360 + 360) % 360 - 180)).toBeLessThan(1)
  })

  it('the cycle’s MIDPOINT keeps its colour — and the default space would go grey', () => {
    // The bug this caught: OKLab is the right default for two chosen colours and
    // the WRONG space for a hue rotation, because a straight line from a colour to
    // its own opposite passes through the middle of the a/b plane.
    const c = stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: RED } })
    const t = vtApplyTrackPreset(c, 'colour-cycle')[0]!.tracks![0]!
    const shipped = mixHex(t.fromColor!, t.toColor!, 0.5, 'oklch')
    const control = mixHex(t.fromColor!, t.toColor!, 0.5, 'oklab')
    console.log('cycle midpoint  oklch', shipped, LC(shipped), '   oklab control', control, LC(control))
    expect(LC(shipped).C).toBeGreaterThan(LC(control).C * 2)
    expect(LC(control).C).toBeLessThan(0.1)   // the control really is near-grey
    expect(LC(shipped).C).toBeGreaterThan(0.15)
  })

  it('reads as ACTIVE once applied, and not merely because some colour track exists', () => {
    const c = stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: RED } })
    expect(vtTrackPresetActive(c, 'colour-cycle')).toBe(false)
    c.motion.moves = vtApplyTrackPreset(c, 'colour-cycle')
    expect(vtTrackPresetActive(c, 'colour-cycle')).toBe(true)
    // A DIFFERENT colour pair on the same leaf is not this preset. Every colour
    // track carries from: 0, to: 1, so comparing only those would say yes here.
    c.motion.moves = trackMoves([ctrack('appearance.Lfill.paint.a', RED, '#00ff00', { easing: 'pingpong' })])
    expect(vtTrackPresetActive(c, 'colour-cycle')).toBe(false)
  })

  it('is REFUSED, with a reason, on a grey fill and on a shader fill', () => {
    const grey = stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: '#888888' } })
    const greyOffer = vtTrackPresetOffer(preset(), grey)
    expect(greyOffer.available).toBe(false)
    expect(greyOffer.reason).toMatch(/saturation/)
    // …and the reason is grammatical, which is why the article is derived.
    expect(vtTrackPresetOffer(preset(), stack({ id: 'Lx', kind: 'stroke', width: 4 })).reason)
      .toBe('Add a fill layer — this needs one to drive.')

    const shader = stack({
      id: 'Lfill',
      kind: 'fill',
      paint: { ...DEFAULT_FILL, type: 'shader', shader: { effectId: 'noise', params: {}, input: RED } } as any,
    })
    expect(vtTrackPresetOffer(preset(), shader).available).toBe(false)
  })

  it('really animates — the preset’s own tracks, through the real evaluator', () => {
    const c = stack({ id: 'Lfill', kind: 'fill', paint: { ...DEFAULT_FILL, a: RED } })
    c.motion.duration = DURATION
    c.motion.moves = vtApplyTrackPreset(c, 'colour-cycle')
    const mid = colorAt(c, DURATION / 2)
    expect(colorAt(c, 0)).toBe(RED)
    expect(mid).not.toBe(RED)
    expect(colorAt(c, DURATION)).toBe(RED)
    // Halfway is as BRIGHT as the ends — the preset mixes in OKLab.
    expect(LC(mid).L).toBeGreaterThan(LC(RED).L - 0.02)
  })

  it('vtOppositeHue keeps the HUE ROTATION exact, giving up chroma to stay in gamut', () => {
    // MEASURED, and it is why `oklchToHexInGamut` exists: with an ordinary
    // per-channel clamp, `#0000ff` rotated 180° came back only 129° away — a
    // third of the rotation silently eaten — and `#ff0000` came back 199° away
    // and 9 % lighter. The whole point of the function is the 180°.
    const rows: Array<Record<string, unknown>> = []
    for (const hex of [RED, BLUE, '#00ff00', '#ffcc00', '#3366aa']) {
      const opp = vtOppositeHue(hex)
      const [L, C, H] = hexToOklch(hex)
      const [L2, C2, H2] = hexToOklch(opp)
      const dH = ((H2 - H) % 360 + 360) % 360
      rows.push({ hex, opposite: opp, dH: +dH.toFixed(2), L: +L.toFixed(3), L2: +L2.toFixed(3), C: +C.toFixed(3), C2: +C2.toFixed(3) })
      // Sub-degree. Not exactly 0: the result is quantised to 8-bit sRGB, and at
      // the reduced chroma one code step is a fraction of a degree of hue.
      expect(Math.abs(dH - 180), `${hex} rotation`).toBeLessThan(1)
      expect(L2, `${hex} lightness`).toBeCloseTo(L, 2)
      // Chroma is what gets given up, never gained.
      expect(C2, `${hex} chroma`).toBeLessThanOrEqual(C + 1e-6)
      expect(C2, `${hex} chroma`).toBeGreaterThan(0)
    }
    console.table(rows)

    // The control: the per-channel clamp `oklchToHex` applies, on the same input.
    const [L, C, H] = hexToOklch(BLUE)
    const naive = hexToOklch(oklchToHex(L, C, (H + 180) % 360))
    expect(Math.abs(((naive[2] - H) % 360 + 360) % 360 - 180)).toBeGreaterThan(20)
  })
})

describe('KineticType `color-cycle` crosses the migration for the first time', () => {
  const params = (over: Record<string, unknown> = {}) => JSON.stringify({
    text: 'LAUNCH', presetId: 'color-cycle', color: '#ff2200', size: 180, duration: 3, fps: 30, stagger: 0, ...over,
  })

  it('is no longer DROPPED', () => {
    expect(presetFidelity('color-cycle')).toBe('partial')
    // Its sibling still is, and for a DIFFERENT reason — colour is resolved once
    // per frame, not per glyph.
    expect(presetFidelity('color-wave')).toBe('dropped')
  })

  it('produces a colour track on the migrated fill layer, that really animates', () => {
    const m = kineticParamsToVectorType(params())
    expect(m.fidelity).toBe('partial')
    const colourMove = m.config.motion.moves.find(mv => mv.kind === 'tracks' && mv.presetId === 'colour-cycle')
    expect(colourMove?.tracks).toHaveLength(1)
    const t = colourMove!.tracks![0]!
    expect(t.fromColor).toBe('#ff2200')
    expect(colourMove!.play.mode).toBe('backAndForth')
    expect(t.path).toBe(`appearance.${m.config.appearance[0]!.id}.paint.a`)
    // The real evaluator, on the real config: frame 0 is the saved colour (a
    // migrated project must open looking like itself) and the middle is not.
    const dur = m.config.motion.duration
    expect(colorAt(m.config, 0)).toBe('#ff2200')
    expect(colorAt(m.config, dur / 2)).not.toBe('#ff2200')
    expect(colorAt(m.config, dur)).toBe('#ff2200')
  })

  it('survives a save/load cycle', () => {
    const m = kineticParamsToVectorType(params())
    const reloaded = mergeConfig(JSON.parse(JSON.stringify(m.config)))
    expect(reloaded.motion.moves).toEqual(m.config.motion.moves)
  })

  it('adds NO colour move for a grey node rather than a row that animates nothing', () => {
    for (const color of ['#ffffff', '#000000', '#888888']) {
      const m = kineticParamsToVectorType(params({ color }))
      expect(m.config.motion.moves.some(mv => mv.presetId === 'colour-cycle'), color).toBe(false)
      // Still reported as `partial`, because the preset IS mapped — the config
      // simply had no hue to rotate.
      expect(m.fidelity, color).toBe('partial')
    }
  })
})
