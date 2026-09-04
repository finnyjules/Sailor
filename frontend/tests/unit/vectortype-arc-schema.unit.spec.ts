/**
 * Vector Type — SKEW and ARC in the schema, in motion, and in the agent's
 * vocabulary. Plus the one decision Task 4 handed on: which FRAME a per-glyph
 * motion offset is measured in.
 *
 * The factory claim this file is here to hold: ONE `ControlSpec[]` declaration
 * yields the inspector, the agent's vocabulary, the motion targets and the
 * Collection sweeps together. Two ways that goes silently wrong, and both are
 * pinned below —
 *
 *  - **a key that does not resolve** against the config is a control that
 *    appears, drags, stores a number and changes nothing. The probe here is
 *    proved non-vacuous by near-miss keys against the SAME config that resolves
 *    the real ones (and, out of band, by deliberately breaking a real key and
 *    watching it go red — see the report);
 *  - **"motion is free" taken on trust.** `animatableTargets` admits any slider
 *    that does not opt out, which is a claim about the DECLARATION. What matters
 *    is whether the geometry actually moves, so every motion test here samples a
 *    real frame and measures placed ink — never `applyMotion(cfg).arc`.
 *
 * NO NETWORK: the same eight-character Inter variable subset the other Vector
 * Type specs use.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { makeConfigParams } from '~/lib/agent/configParams'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  VT_ARC_MAX,
  VT_SKEW_MAX,
  mergeConfig,
  type VectorTypeConfig,
  type VtMove,
} from '~/lib/vectortype/config'
import { VT_CONTROLS, VT_GUIDANCE, VT_SECTIONS } from '~/lib/vectortype/controls'
import { vtAgentControls, vtBindableControls } from '~/lib/vectortype/agentControls'
import { animatableTargets } from '~/lib/vectortype/motion'
import { vectorTypeFrame, vectorTypeSVG, vtPlacement, vtRunShear } from '~/lib/vectortype/canvas'
import { glyphTransform, placedInkBounds } from '~/lib/vectortype/render'
import { vtCellPivot, vtGlyphOffset } from '~/lib/vectortype/extrude'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()

/** The fixture only carries " Sailorg". */
const WORD = 'Sailor'
const BOX = { width: 640, height: 400 }

const cfg = (patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })

/** One `kind: 'tracks'` move wrapping a single track — `ease: 'none'`/
 *  `loop: false` (a one-shot transition) reproduce the old default
 *  `easing: 'linear'`/`loops: 1` (the mapping `~/lib/studio/moves/merge`'s
 *  `legacyTrackEase`/`legacyTrackPlacement` use). */
let trackMoveSeq = 0
function trackMove(path: string, from: number, to: number): VtMove {
  trackMoveSeq += 1
  return {
    id: `move-t${trackMoveSeq}`,
    at: 0,
    kind: 'tracks',
    presetId: 'custom',
    duration: 1,
    loop: false,
    ease: { kind: 'named', name: 'none' },
    tracks: [{ path, from, to, hold: 0, cycleOffset: 0, delay: 0 }],
  }
}

/** A one-track motion block. `duration: 1` so `t` reads as the track fraction. */
const track = (path: string, from: number, to: number): Partial<VectorTypeConfig> => ({
  motion: {
    ...DEFAULT_CONFIG.motion,
    duration: 1,
    moves: [trackMove(path, from, to)],
  },
} as Partial<VectorTypeConfig>)

/** The run's PLACED ink at time `t` — real geometry, through the real pipeline,
 *  after motion. This is what "it moved" is measured on, not a config field. */
function ink(c: VectorTypeConfig, t: number) {
  const frame = vectorTypeFrame(font, c, t)
  const place = vtPlacement(frame, BOX)
  return placedInkBounds(frame.outlines, place)
}

/** The run's shear matrix at time `t`, built the way both renderers build it. */
function shearAt(c: VectorTypeConfig, t: number) {
  const frame = vectorTypeFrame(font, c, t)
  return vtRunShear(frame.config, frame.outlines, vtPlacement(frame, BOX), BOX)
}

/** Each glyph's placed origin and tangent angle at time `t`. */
function origins(c: VectorTypeConfig, t: number) {
  const frame = vectorTypeFrame(font, c, t)
  const place = vtPlacement(frame, BOX)
  return frame.outlines.glyphs.map(g => glyphTransform(g, place))
}

const paths = (svg: string): string[] => svg.match(/<path\b[^>]*\/>/g) ?? []
const attrOf = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
/** Every number a path `d` mentions — the geometry, as it lands in the file. */
const numbersIn = (svg: string) => paths(svg).map(t => attrOf(t, 'd') ?? '').join(' ')
/** The geometry AND the element transform — the whole drawn result, since a
 *  shear leaves the path data alone and rides the `transform` attribute. */
const drawnIn = (svg: string) =>
  paths(svg).map(t => `${attrOf(t, 'transform') ?? ''}|${attrOf(t, 'd') ?? ''}`).join(' ')

const DEG = Math.PI / 180

// ════════════════════════════════════════════════════════════════════════════
// 1. THE DECLARATION
// ════════════════════════════════════════════════════════════════════════════

describe('skew and arc are declared in Layout', () => {
  const spec = (key: string) => VT_CONTROLS.find(c => c.key === key)

  it('puts all three in the EXISTING Layout group — no new section', () => {
    // `size`, `tracking` and `align` already live there; a fourth section for
    // "the ones that bend it" would be a taxonomy the user has to learn.
    for (const key of ['skewX', 'skewY', 'arc']) {
      expect(spec(key), key).toBeDefined()
      expect(spec(key)!.group, key).toBe('Layout')
    }
    expect(VT_SECTIONS).toContain('Layout')
  })

  it('declares arc as SWEEP over the config’s own bound, defaulting to straight', () => {
    const arc = spec('arc') as any
    expect(arc.kind).toBe('slider')
    // The bound is `config.ts`'s, not a second hand-written number — a slider
    // that stopped short of `vtArcSweep`'s clamp would make part of the range
    // reachable by a motion track and by nothing else.
    expect(arc.min).toBe(-VT_ARC_MAX)
    expect(arc.max).toBe(VT_ARC_MAX)
    expect(arc.default).toBe(DEFAULT_CONFIG.arc)
    expect(arc.default).toBe(0)
    expect(arc.step).toBe(1)
  })

  it('declares the skew pair over VT_SKEW_MAX, the determinant bound', () => {
    for (const key of ['skewX', 'skewY']) {
      const s = spec(key) as any
      expect(s.kind, key).toBe('slider')
      expect(s.min, key).toBe(-VT_SKEW_MAX)
      expect(s.max, key).toBe(VT_SKEW_MAX)
      expect(s.default, key).toBe(0)
    }
  })

  it('leaves all three ANIMATABLE — none of them opts out', () => {
    // `animatableTargets` reads exactly this flag. Asserted on the declaration
    // as well as on the target list because a silent `animatable: false` here is
    // the quiet failure this task exists to rule out.
    for (const key of ['skewX', 'skewY', 'arc']) {
      expect((spec(key) as any).animatable, key).not.toBe(false)
    }
  })
})

describe('every declared skew/arc key RESOLVES', () => {
  const KEYS = ['skewX', 'skewY', 'arc'] as const

  it('resolves EVERY key the Layout group declares — read off the declaration', () => {
    // Derived from `VT_CONTROLS`, not from a hand-written list, so a mis-typed
    // key in the declaration lands HERE rather than in a passing test beside a
    // silently dead slider. (Confirmed by breaking it: renaming the declared
    // `arc` key to `arcc` turns exactly this red — see the task report.)
    const declared = VT_CONTROLS.filter(c => c.group === 'Layout').map(c => c.key)
    expect(declared).toEqual(expect.arrayContaining([...KEYS]))
    const c = cfg({ skewX: 12, skewY: -7, arc: 150 })
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    expect(declared.filter(k => params[k] === undefined)).toEqual([])
  })

  it('resolves through makeConfigParams, and reads the stored number back', () => {
    // Not merely "defined": the ACTUAL values, so a key landing on some other
    // real leaf would still fail.
    const c = cfg({ skewX: 12, skewY: -7, arc: 150 })
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    expect(KEYS.filter(k => params[k] === undefined)).toEqual([])
    expect(params.skewX).toBe(12)
    expect(params.skewY).toBe(-7)
    expect(params.arc).toBe(150)
  })

  it('the probe is NOT vacuous — near-miss keys resolve to nothing', () => {
    // Against the SAME config that resolves all three above. If any of these
    // ever passes, the test above has stopped proving anything.
    const params = makeConfigParams(() => cfg({ arc: 150 }), () => 0, 'appearance')
    for (const bad of ['arcc', 'Arc', 'layout.arc', 'skew', 'skewZ', 'skew.x', 'config.arc']) {
      expect(params[bad], bad).toBeUndefined()
    }
  })

  it('WRITING through the resolved key bends the real run', () => {
    // The failure a resolution check alone cannot see: a key that reads and
    // writes a leaf nothing renders from. So the write goes through the proxy
    // and the RESULT is measured on the placed geometry.
    const c = cfg()
    const flat = ink(c, 0)
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    params.arc = 180
    expect(c.arc).toBe(180)
    const bent = ink(c, 0)
    // A half-turn is taller than it is wide; the straight run is the opposite.
    expect(bent.maxY - bent.minY).toBeGreaterThan((flat.maxY - flat.minY) * 2)
    params.skewX = 30
    expect(shearAt(c, 0)).not.toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. MOTION IS FREE — CONFIRMED, WITH GEOMETRY
// ════════════════════════════════════════════════════════════════════════════

describe('motion is free for skew and arc — confirmed, not assumed', () => {
  it('offers all three as targets, at the DECLARED ranges', () => {
    const targets = animatableTargets(cfg())
    const byPath = new Map(targets.map(t => [t.path, t]))
    for (const key of ['skewX', 'skewY', 'arc']) {
      const t = byPath.get(key)
      expect(t, `${key} is not an animatable target`).toBeDefined()
      expect(t!.group, key).toBe('Layout')
    }
    expect(byPath.get('arc')!.min).toBe(-VT_ARC_MAX)
    expect(byPath.get('arc')!.max).toBe(VT_ARC_MAX)
    expect(byPath.get('skewX')!.max).toBe(VT_SKEW_MAX)
  })

  it('BROKEN CONTROL: the target list is not "everything in Layout"', () => {
    // `align` is a select and `fontId` opts out — if either appeared, the list
    // above would be proving nothing about the `animatable` flag.
    const paths = animatableTargets(cfg()).map(t => t.path)
    expect(paths).not.toContain('align')
    expect(paths).not.toContain('fontId')
    expect(paths).toContain('size')
  })

  it('an animated ARC actually bends the geometry, frame by frame', () => {
    const c = cfg(track('arc', 0, 240))
    // The run's ink height, sampled across the clip. It must GROW monotonically
    // as the sweep opens — a config value that moved while the geometry did not
    // is exactly the failure this measures instead of.
    const heights = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const b = ink(c, t)
      return b.maxY - b.minY
    })
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!, `t=${i}`).toBeGreaterThan(heights[i - 1]! + 1)
    }
    // And it is a real bend, not a drift: at rest every glyph is upright, and at
    // the far end they fan across a wide spread of tangent angles.
    const rest = origins(c, 0).map(o => o.rotate)
    const bent = origins(c, 1).map(o => o.rotate)
    expect(rest.every(r => r === 0)).toBe(true)
    expect(Math.max(...bent) - Math.min(...bent)).toBeGreaterThan(150)
    // t=0 is byte-identical to a config that was never animated — the continuity
    // that makes an animated arc a smooth bend rather than a pop.
    expect(numbersIn(vectorTypeSVG(font, c, 0, BOX).svg))
      .toBe(numbersIn(vectorTypeSVG(font, cfg(), 0, BOX).svg))
  })

  it('an animated SKEW actually leans the geometry, frame by frame', () => {
    const c = cfg(track('skewX', 0, 30))
    // The shear is `null` at rest and grows; measured on the matrix the BOTH
    // renderers use, then on the exported path data so it is not just a helper
    // agreeing with itself.
    expect(shearAt(cfg(), 0)).toBeNull()
    const shears = [0.25, 0.5, 0.75, 1].map(t => shearAt(c, t))
    const terms = shears.map(s => Math.abs(s![2]))
    for (let i = 1; i < terms.length; i++) expect(terms[i]!).toBeGreaterThan(terms[i - 1]!)
    // tan 30° = 0.5774, and the shear's off-diagonal term IS that tangent.
    expect(terms[terms.length - 1]!).toBeCloseTo(Math.tan(30 * DEG), 6)
    // In the FILE: the leading matrix appears once the lean starts, and not at 0.
    expect(vectorTypeSVG(font, c, 1, BOX).svg).toContain('matrix(')
    expect(vectorTypeSVG(font, c, 0, BOX).svg).not.toContain('matrix(')
  })

  it('an animated skew and an animated arc COMPOSE', () => {
    // Both channels on one clip. The picture is the bend leaning, not one of the
    // two silently winning — asserted as: the ink differs from either alone.
    const both = cfg({
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: 1,
        moves: [trackMove('arc', 0, 180), trackMove('skewX', 0, 30)],
      },
    } as Partial<VectorTypeConfig>)
    const svg = vectorTypeSVG(font, both, 1, BOX).svg
    expect(svg).toContain('matrix(')
    // Compared on the transform AND the path data: a shear leaves `d` alone and
    // rides the element transform, so `d` alone would call these three equal.
    expect(drawnIn(svg)).not.toBe(drawnIn(vectorTypeSVG(font, cfg(track('arc', 0, 180)), 1, BOX).svg))
    expect(drawnIn(svg)).not.toBe(drawnIn(vectorTypeSVG(font, cfg(track('skewX', 0, 30)), 1, BOX).svg))
    // The bend is in `d` and the lean is in the transform — both present, so
    // neither channel was silently dropped when the other was applied.
    expect(numbersIn(svg)).toBe(numbersIn(vectorTypeSVG(font, cfg(track('arc', 0, 180)), 1, BOX).svg))
    expect(numbersIn(svg)).not.toBe(numbersIn(vectorTypeSVG(font, cfg(), 0, BOX).svg))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. THE AGENT
// ════════════════════════════════════════════════════════════════════════════

describe('the agent can reach the bend and the lean', () => {
  it('offers all three, with their hints, in the tune vocabulary', () => {
    const keys = vtAgentControls(cfg()).map(c => c.key)
    for (const k of ['skewX', 'skewY', 'arc']) expect(keys, k).toContain(k)
    // A hint is what the model reads to choose between two similar knobs.
    for (const k of ['skewX', 'skewY', 'arc']) {
      const c = vtAgentControls(cfg()).find(x => x.key === k)!
      expect((c as any).hint, k).toBeTruthy()
    }
  })

  it('offers them to Collection bindings too — one declaration, both consumers', () => {
    const keys = vtBindableControls(cfg()).map(c => c.key)
    for (const k of ['skewX', 'skewY', 'arc']) expect(keys, k).toContain(k)
  })

  it('names arc in the guidance, and only as the key that exists', () => {
    expect(VT_GUIDANCE).toContain('`arc`')
    // No invented sibling — a `radius` or an `arcRadius` in the prose would
    // teach the model a patch `validatePatch` drops without a word.
    expect(VT_GUIDANCE).not.toMatch(/`arcRadius`|`radius`|`curve`|`bend`/)
  })

  it('teaches the words a user would actually use', () => {
    // "curve the text into an arc" has to land on `arc`, and "slant it" on the
    // slant AXIS first and the shear second. The prose is what maps them.
    for (const word of ['curved', 'arch', 'ring', 'badge']) {
      expect(VT_GUIDANCE.toLowerCase(), word).toContain(word)
    }
    expect(VT_GUIDANCE).toMatch(/slanted type[\s\S]*`axes\.slnt` FIRST/)
  })

  it('says the letterforms are NOT bent — the thing the model would assume', () => {
    // The bend is rigid-body placement. A model told only "bends the text" will
    // happily promise warped letterforms this studio deliberately does not do.
    expect(VT_GUIDANCE).toMatch(/letterforms/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. THE HANDED-DOWN DECISION — which frame is `glyph.dx`/`dy` in?
// ════════════════════════════════════════════════════════════════════════════

/**
 * DECIDED: the GLYPH's own frame. `dy` is a baseline shift, and every type tool
 * moves type-on-a-path off the CURVE rather than down the artboard; it is also
 * the only motion channel that was not already local (`rotate` composes onto the
 * placement angle, the `scaleX`/`scaleY` pivot is `vtCellPivot` in the glyph's
 * frame, and the mask window is the glyph's own cell).
 *
 * The full argument, including why the extrude's ONE ABSOLUTE LIGHT is not the
 * same question, is on `vtGlyphOffset`.
 */
describe('glyph.dx/dy is in the GLYPH’s frame — the decision, asserted', () => {
  it('is EXACTLY inert on a straight run — the same doubles, not merely close', () => {
    // Every run that exists today is straight (the placement only ever turns on
    // a curve), so this is what says the decision cannot move a flat composition.
    for (const [dx, dy] of [[0, 0], [12, -34.5], [-7.25, 0], [1e-9, 1e9]] as const) {
      const o = vtGlyphOffset(dx, dy, 0)
      expect(Object.is(o.x, dx), `${dx}`).toBe(true)
      expect(Object.is(o.y, dy), `${dy}`).toBe(true)
      expect(vtGlyphOffset(dx, dy, undefined)).toEqual({ x: dx, y: dy })
    }
  })

  it('survives junk rather than propagating NaN into a placement', () => {
    expect(vtGlyphOffset(NaN, 5, 30)).toEqual(vtGlyphOffset(0, 5, 30))
    expect(vtGlyphOffset(5, Infinity, 30)).toEqual(vtGlyphOffset(5, 0, 30))
    expect(vtGlyphOffset(3, 4, NaN)).toEqual({ x: 3, y: 4 })
  })

  it('turns the offset into the tangent frame, preserving its LENGTH', () => {
    // A rigid rotation: the letter moves the distance the track asked for,
    // whatever angle it sits at. (A frame change that also scaled would make a
    // preset's travel depend on where in the word a letter landed.)
    for (const rot of [-125.3, -91.1, -36.9, 0, 37.5, 90, 180]) {
      const o = vtGlyphOffset(0, -40, rot)
      expect(Math.hypot(o.x, o.y), `${rot}`).toBeCloseTo(40, 9)
    }
    // 90° clockwise takes "up off the baseline" to "forward along the output x".
    const q = vtGlyphOffset(0, -40, 90)
    expect(q.x).toBeCloseTo(40, 9)
    expect(q.y).toBeCloseTo(0, 9)
  })

  it('keeps a pure `dy` PERPENDICULAR to the glyph’s own baseline at every sweep', () => {
    // THE POINT, stated as the invariant the mask presets depend on: `dy` and
    // the glyph's tangent must stay 90° apart whatever the arc does. The tangent
    // comes from the real placement, not from the same arithmetic.
    const angles: number[] = []
    const broken: number[] = []
    for (const arc of [0, 60, 150, 240, 330]) {
      for (const o of origins(cfg({ arc }), 0)) {
        const d = vtGlyphOffset(0, -40, o.rotate)
        const tan = { x: Math.cos(o.rotate * DEG), y: Math.sin(o.rotate * DEG) }
        // |cos| of the angle between them — 0 is perpendicular.
        angles.push(Math.abs((d.x * tan.x + d.y * tan.y) / 40))
        // BROKEN CONTROL: the PRE-FIX output-space offset, same glyphs.
        broken.push(Math.abs((0 * tan.x + -40 * tan.y) / 40))
      }
    }
    expect(Math.max(...angles)).toBeLessThan(1e-9)
    // …and the control is genuinely broken: on a bent run the output-space
    // offset lands almost ALONG some letters' baselines, which is the letter
    // sliding through its own mask window instead of out from under it.
    expect(Math.max(...broken)).toBeGreaterThan(0.9)
  })

  it('the EXPORT writes the local offset — canvas and file cannot disagree', () => {
    const c = cfg({ arc: 240, ...track('glyph.dy', -60, -60) })
    const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
    const os = origins(c, 0.5)
    const translates = paths(svg)
      .map(t => attrOf(t, 'transform') ?? '')
      .map(s => /translate\(([-\d.]+) ([-\d.]+)\)/.exec(s))
      .filter(Boolean)
      .map(m => ({ x: Number(m![1]), y: Number(m![2]) }))
    expect(translates.length).toBe(os.length)
    // Each leading translate is that glyph's origin plus its offset TURNED into
    // its own frame — never `origin + (0, -60)`.
    for (const t of translates) {
      expect(os.some((o) => {
        const d = vtGlyphOffset(0, -60, o.rotate)
        return Math.abs(o.x + d.x - t.x) < 0.01 && Math.abs(o.y + d.y - t.y) < 0.01
      }), `${t.x},${t.y}`).toBe(true)
      // BROKEN CONTROL: the pre-fix expression matches none of them, except by
      // coincidence on a glyph that happens to sit upright.
      expect(os.filter(o => Math.abs(o.x - t.x) < 0.01 && Math.abs(o.y + -60 - t.y) < 0.01).length)
        .toBe(0)
    }
  })

  it('a STRAIGHT run’s export is byte-identical to the pre-fix one', () => {
    // The whole installed base, in one assertion: `arc: 0` writes exactly the
    // transform list it always wrote.
    const c = cfg(track('glyph.dy', -120, 0))
    const { svg } = vectorTypeSVG(font, c, 0.4, BOX)
    const os = origins(c, 0.4)
    const dy = -120 + 120 * 0.4
    for (const tag of paths(svg)) {
      const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(attrOf(tag, 'transform') ?? '')!
      // The file rounds to 3 decimals, so the tolerance is the rounding and
      // nothing more — this is `origin + (0, dy)` written out, unchanged.
      expect(os.some(o =>
        Math.abs(o.x - Number(m[1])) < 0.001 && Math.abs(o.y + dy - Number(m[2])) < 0.001,
      )).toBe(true)
    }
  })

  it('is the SAME frame the cell pivot already used — one glyph frame, not two', () => {
    // `vtCellPivot` walks half an advance along the tangent; `vtGlyphOffset` takes
    // an arbitrary vector through the same rotation. Composed, a `dx` of exactly
    // one advance must land on twice the pivot — i.e. they agree about which way
    // "forward along this letter's baseline" points.
    for (const rot of [-125.3, -36.9, 37.5, 90]) {
      const p = vtCellPivot(100, rot)
      const d = vtGlyphOffset(100, 0, rot)
      expect(d.x, `${rot}`).toBeCloseTo(p.x * 2, 9)
      expect(d.y, `${rot}`).toBeCloseTo(p.y * 2, 9)
    }
  })
})
