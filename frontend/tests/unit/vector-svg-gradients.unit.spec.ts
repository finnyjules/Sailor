/**
 * The vector spine's `<defs>` — gradient paint servers.
 *
 * Same two halves as `vector-svg-defs.unit.spec.ts`, and the same rule: the
 * spine half says nothing about type, the adapter half checks that what the
 * canvas renderer paints is what the export writes.
 *
 * The failure modes this is aimed at, none of which a picture can see:
 *
 *  - **One gradient per glyph.** Forty letters sharing one ramp emitting forty
 *    identical `<linearGradient>` elements still looks right; it is just a file
 *    no designer wants to open.
 *  - **A ramp that travels with the letter.** `word`/`frame` anchoring means the
 *    type moves OVER a fill that stays put. A `userSpaceOnUse` server is
 *    resolved in the user space of the element actually painted, so a `<path>`
 *    with a motion `transform` drags it along — and `fill` being inherited, the
 *    untransformed wrapper `<g>` that fixes this for `clip-path` and `filter`
 *    does nothing here. Every frame still shows a gradient on a word.
 *  - **Re-derived angle trig.** `45°` on a non-square box is not `45°` to the
 *    horizon in either renderer; two independent derivations agree on the
 *    square case and drift everywhere else.
 *  - **An ellipse where the canvas draws a circle.** SVG fits a radial to the
 *    bounding box; the canvas resolver uses `max(w, h) / 2`.
 *  - **Colliding ids.** Two exports pasted into one document, one word's letters
 *    picking up the other word's ramp.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import {
  type Affine,
  type VectorShape,
  defsIdPrefix,
  gradientUnitAxis,
  invertAffine,
  isVectorGradient,
  multiplyAffine,
  shapesToSVG,
} from '~/lib/vector/svg'
import { paintToVectorPaint } from '~/lib/paint/toVector'
import { DEFAULT_FILL, type Fill } from '~/lib/spacetype/fillTile'
import type { Gradient } from '~/lib/compositor/paint'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, vtLayer, type VectorTypeConfig } from '~/lib/vectortype/config'
import { vectorTypeSVG, vectorTypeFrame, vtPlacement, vtRunPaintBox, vtGlyphPaintBox } from '~/lib/vectortype/canvas'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()
const WORD = 'Sail'
const BOX = { width: 400, height: 200 }

const RAMP: Fill = { ...DEFAULT_FILL, type: 'gradient', a: '#ff0000', b: '#0000ff', angle: 0 }


/** ═══ APPEARANCE STACK ═══ the `fill` / `fillAnchor` a caller asks for is now
 *  the BASE FILL LAYER's paint and anchor. Translated here so every call site
 *  below reads as it did — the stack is what changed, not what these tests
 *  assert about the document. */
function vtStack(fill: unknown, fillAnchor: unknown) {
  return [vtLayer({ id: 'Lfill', paint: fill as any, anchor: (fillAnchor ?? 'glyph') as any })]
}

function cfg(patch: Partial<VectorTypeConfig> & Record<string, unknown> = {}): VectorTypeConfig {
  const { fill, fillAnchor, ...rest } = patch as Record<string, unknown>
  return mergeConfig({
    ...DEFAULT_CONFIG, text: WORD, size: 100,
    appearance: vtStack(fill ?? { ...RAMP }, fillAnchor), ...rest,
  })
}

function withPreset(presetId: string, patch: Partial<VectorTypeConfig> = {}) {
  const c = cfg(patch)
  return mergeConfig({ ...c, motion: { ...c.motion, in: { presetId, duration: 1, ease: 'none' } } })
}

function square(x: number, y: number, s = 10): VectorShape['commands'] {
  return [
    { command: 'moveTo', args: [x, y] },
    { command: 'lineTo', args: [x + s, y] },
    { command: 'lineTo', args: [x + s, y + s] },
    { command: 'lineTo', args: [x, y + s] },
    { command: 'closePath', args: [] },
  ]
}

const DOC = { width: 200, height: 100, viewBox: [0, 0, 200, 100] as [number, number, number, number] }
const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length
const LINEARS = /<linearGradient\b/g
const RADIALS = /<radialGradient\b/g
const idsIn = (svg: string) => (svg.match(/\bid="([^"]+)"/g) ?? []).map(s => s.slice(4, -1))
const attr = (svg: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(svg)?.[1]

const TWO_STOPS = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]

// ── the spine ───────────────────────────────────────────────────────────────

describe('gradientUnitAxis — the ONE definition of what an angle means', () => {
  // The formula the canvas has always used, written out INDEPENDENTLY here
  // (`W/2 ± cos(a)·W/2`, `H/2 ± sin(a)·H/2` — what `fillTileBox` and
  // `resolvePaint` spelled out before they were routed through the shared
  // helper). If the helper ever stops matching this, the export and the screen
  // have parted company.
  const canvasAxis = (deg: number, W: number, H: number) => {
    const rad = (deg * Math.PI) / 180
    const hx = (Math.cos(rad) * W) / 2
    const hy = (Math.sin(rad) * H) / 2
    return { x1: W / 2 - hx, y1: H / 2 - hy, x2: W / 2 + hx, y2: H / 2 + hy }
  }

  it('reproduces the canvas trig on square AND non-square boxes', () => {
    for (const deg of [0, 30, 45, 90, 135, 180, 270, 359, -45]) {
      for (const [W, H] of [[100, 100], [400, 50], [37, 913]] as const) {
        const want = canvasAxis(deg, W, H)
        const got = gradientUnitAxis(deg)
        expect(got.x1 * W).toBeCloseTo(want.x1, 9)
        expect(got.y1 * H).toBeCloseTo(want.y1, 9)
        expect(got.x2 * W).toBeCloseTo(want.x2, 9)
        expect(got.y2 * H).toBeCloseTo(want.y2, 9)
      }
    }
  })

  it('runs left→right at 0° and top→bottom at 90° — y is DOWN', () => {
    expect(gradientUnitAxis(0)).toEqual({ x1: 0, y1: 0.5, x2: 1, y2: 0.5 })
    const q = gradientUnitAxis(90)
    expect(q.x1).toBeCloseTo(0.5, 12)
    expect(q.y1).toBeCloseTo(0, 12)
    expect(q.y2).toBeCloseTo(1, 12)
  })

  it('lands a non-finite angle on 0 rather than writing NaN into the file', () => {
    expect(gradientUnitAxis(Number.NaN)).toEqual(gradientUnitAxis(0))
  })
})

describe('affine helpers', () => {
  it('multiplies in SVG order — the right-hand matrix applies FIRST', () => {
    const T: Affine = [1, 0, 0, 1, 10, 20]
    const S: Affine = [2, 0, 0, 2, 0, 0]
    // translate(10 20) scale(2): a point at (1,1) → (12, 22).
    const m = multiplyAffine(T, S)
    expect([m[0] * 1 + m[2] * 1 + m[4], m[1] * 1 + m[3] * 1 + m[5]]).toEqual([12, 22])
  })

  it('inverts, and refuses a singular matrix instead of emitting Infinity', () => {
    const m: Affine = [2, 0, 0, 3, 5, 7]
    const inv = invertAffine(m) as Affine
    const id = multiplyAffine(m, inv)
    expect(id[0]).toBeCloseTo(1, 12)
    expect(id[3]).toBeCloseTo(1, 12)
    expect(id[4]).toBeCloseTo(0, 12)
    expect(id[5]).toBeCloseTo(0, 12)
    expect(invertAffine([0, 0, 0, 0, 0, 0])).toBeNull()
    expect(invertAffine([Number.NaN, 0, 0, 1, 0, 0])).toBeNull()
  })
})

describe('<linearGradient> — one per DISTINCT value, not one per shape', () => {
  const ramp = (angle: number) => ({ type: 'linear' as const, angle, stops: TWO_STOPS })

  it('collapses 40 shapes sharing a ramp into ONE paint server', () => {
    const shapes: VectorShape[] = []
    for (let i = 0; i < 40; i++) shapes.push({ commands: square(i * 4, 10), fill: ramp(45) })
    const svg = shapesToSVG(shapes, DOC)
    expect(count(svg, LINEARS)).toBe(1)
    expect(count(svg, /fill="url\(#/g)).toBe(40)
    const ids = idsIn(svg)
    expect(ids.length).toBe(1)
    expect(svg).toContain(`fill="url(#${ids[0]})"`)
  })

  it('keeps genuinely different ramps apart, numbered in first-use order', () => {
    const svg = shapesToSVG([
      { commands: square(10, 10), fill: ramp(0) },
      { commands: square(30, 10), fill: ramp(90) },
      { commands: square(50, 10), fill: ramp(0) },
    ], { ...DOC, idPrefix: 'mine' })
    expect(count(svg, LINEARS)).toBe(2)
    expect(svg).toContain('id="mine-g0"')
    expect(svg).toContain('id="mine-g1"')
    // first and third shape share g0; the middle one is g1.
    expect(count(svg, /fill="url\(#mine-g0\)"/g)).toBe(2)
    expect(count(svg, /fill="url\(#mine-g1\)"/g)).toBe(1)
  })

  it('writes objectBoundingBox coordinates in the UNIT square', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), fill: ramp(0) }], DOC)
    expect(svg).toContain('gradientUnits="objectBoundingBox"')
    expect(svg).toContain('x1="0" y1="0.5" x2="1" y2="0.5"')
    expect(svg).toContain('<stop offset="0" stop-color="#ff0000"/>')
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff"/>')
  })

  it('writes userSpaceOnUse coordinates scaled onto the given box', () => {
    const svg = shapesToSVG([{
      commands: square(10, 10),
      fill: { type: 'linear', angle: 0, stops: TWO_STOPS, units: 'userSpaceOnUse', box: { x: 20, y: 40, width: 100, height: 60 } },
    }], DOC)
    expect(svg).toContain('gradientUnits="userSpaceOnUse"')
    // angle 0 → the box's left-middle to its right-middle.
    expect(svg).toContain('x1="20" y1="70" x2="120" y2="70"')
  })

  it('emits gradientTransform as a matrix, and nothing when there is none', () => {
    const withXf = shapesToSVG([{
      commands: square(10, 10),
      fill: { type: 'linear', angle: 0, stops: TWO_STOPS, units: 'userSpaceOnUse', box: { x: 0, y: 0, width: 10, height: 10 }, transform: [1, 0, 0, 1, -30, 0] },
    }], DOC)
    expect(withXf).toContain('gradientTransform="matrix(1 0 0 1 -30 0)"')
    expect(shapesToSVG([{ commands: square(10, 10), fill: ramp(0) }], DOC)).not.toContain('gradientTransform')
  })

  it('sorts and clamps stops, and writes stop-opacity only when it bites', () => {
    const svg = shapesToSVG([{
      commands: square(10, 10),
      fill: {
        type: 'linear',
        angle: 0,
        stops: [
          { offset: 1.4, color: '#00ff00' },
          { offset: -2, color: '#ff0000', opacity: 0.5 },
          { offset: 0.5, color: '#0000ff', opacity: 1 },
        ],
      },
    }], DOC)
    const stops = [...svg.matchAll(/<stop([^/]*)\/>/g)].map(m => m[1] as string)
    expect(stops.length).toBe(3)
    expect(stops[0]).toContain('offset="0"')
    expect(stops[0]).toContain('stop-color="#ff0000"')
    expect(stops[0]).toContain('stop-opacity="0.5"')
    expect(stops[1]).toContain('offset="0.5"')
    expect(stops[1]).not.toContain('stop-opacity')
    expect(stops[2]).toContain('offset="1"')
  })

  it('leaves a plain colour, an explicit none, and an absent fill exactly as they were', () => {
    const svg = shapesToSVG([
      { commands: square(10, 10), fill: '#abcdef' },
      { commands: square(30, 10), fill: null },
      { commands: square(50, 10) },
    ], DOC)
    expect(svg).not.toContain('<defs>')
    expect(svg).toContain('fill="#abcdef"')
    expect(svg).toContain('fill="none"')
    expect(svg).toMatch(/<path d="[^"]*" fill-rule|<path d="[^"]*"\/>/)
  })
})

describe('<radialGradient> — a circle, not SVG\'s bbox ellipse', () => {
  it('writes a bounding-box radial at the centre with r 0.5', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), fill: { type: 'radial', stops: TWO_STOPS } }], DOC)
    expect(count(svg, RADIALS)).toBe(1)
    expect(svg).toContain('cx="0.5" cy="0.5" r="0.5"')
  })

  it('writes a user-space radial at the box centre with r = max(w,h)/2 — the canvas rule', () => {
    const svg = shapesToSVG([{
      commands: square(10, 10),
      fill: { type: 'radial', stops: TWO_STOPS, units: 'userSpaceOnUse', box: { x: 0, y: 0, width: 400, height: 100 } },
    }], DOC)
    expect(svg).toContain('cx="200" cy="50" r="200"')
  })

  const radialAt = (aspect: number) =>
    shapesToSVG([{ commands: square(10, 10), fill: { type: 'radial', stops: TWO_STOPS, aspect } }], DOC)

  it('corrects the ellipse on a non-square box, and leaves a square one alone', () => {
    expect(radialAt(1)).not.toContain('gradientTransform')
    // A box twice as wide as it is tall: the canvas circle has radius w/2, so
    // the y radius has to grow by the aspect, about the centre.
    expect(radialAt(2)).toContain('gradientTransform="matrix(1 0 0 2 0 -0.5)"')
    expect(radialAt(0.5)).toContain('gradientTransform="matrix(2 0 0 1 -0.5 0)"')
  })

  it('has no angle to write — a radial ignores it', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), fill: { type: 'radial', angle: 45, stops: TWO_STOPS } as any }], DOC)
    expect(svg).not.toContain('x1=')
  })
})

describe('ids — stable, and unique across documents', () => {
  const doc = (color: string, x: number) =>
    shapesToSVG([{ commands: square(x, 10), fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color }, { offset: 1, color: '#000' }] } }], DOC)

  it('are byte-identical when the same document is exported twice', () => {
    expect(doc('#ff0000', 10)).toBe(doc('#ff0000', 10))
  })

  it('do not collide when two exports are pasted into one file', () => {
    const a = idsIn(doc('#ff0000', 10))
    const b = idsIn(doc('#00ff00', 40))
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(a.filter(id => b.includes(id))).toEqual([])
  })

  it('differ when only the PAINT SERVER differs — same geometry, different ramp', () => {
    // The id prefix hashes the defs as well as the ink. Two files with identical
    // paths but different gradients must not agree on `…-g0`, or pasting them
    // together makes one word wear the other's colours.
    expect(idsIn(doc('#ff0000', 10))[0]).not.toBe(idsIn(doc('#00ff00', 10))[0])
  })

  it('leaves a gradient-free document hashing exactly as it did before', () => {
    // The signature only grows a gradient segment when there ARE gradients, so
    // every file exported before paint servers existed still re-exports
    // byte-identically. Pinned against the literal, which is what a stale
    // previously-exported file holds.
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 4 }], DOC)
    // viewBox | (blur keys) | (clip keys) | the paths — a gradient segment would
    // add a fourth `|…` here, and this document must not grow one.
    const want = defsIdPrefix(`0 0 200 100|4||<path d="M10 10L20 10L20 20L10 20Z"/>`)
    expect(idsIn(svg)[0]).toBe(`${want}-b0`)
  })
})

// ── Paint → the spine's vocabulary ──────────────────────────────────────────

describe('paintToVectorPaint — which of the nine fills have a vector form', () => {
  const obb = { units: 'objectBoundingBox' } as const

  it('passes a flat colour and a solid Fill straight through as a string', () => {
    expect(paintToVectorPaint('#ff8800', obb)).toBe('#ff8800')
    expect(paintToVectorPaint({ ...DEFAULT_FILL, type: 'solid', a: '#123456' }, obb)).toBe('#123456')
  })

  it('expands a Fill\'s two-colour shorthand into real stops at its angle', () => {
    const g = paintToVectorPaint({ ...RAMP, angle: 45 }, obb)
    expect(isVectorGradient(g)).toBe(true)
    expect(g).toMatchObject({
      type: 'linear',
      angle: 45,
      units: 'objectBoundingBox',
      stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
    })
  })

  it('keeps a multi-stop Gradient\'s every stop — the shape Fill cannot express', () => {
    const paint: Gradient = {
      type: 'linear',
      angle: 20,
      stops: [{ offset: 1, color: '#0f0' }, { offset: 0, color: '#f00' }, { offset: 0.5, color: '#00f' }],
    }
    const g = paintToVectorPaint(paint, obb) as any
    expect(g.stops.map((s: any) => s.color)).toEqual(['#f00', '#00f', '#0f0'])
  })

  it('carries a radial through as a radial, with the shape\'s aspect attached', () => {
    const paint: Gradient = { type: 'radial', stops: TWO_STOPS }
    expect(paintToVectorPaint(paint, { units: 'objectBoundingBox', aspect: 2 })).toMatchObject({
      type: 'radial',
      units: 'objectBoundingBox',
      aspect: 2,
    })
    // …and a user-space one has no use for it: the radius is written out.
    expect(paintToVectorPaint(paint, { units: 'userSpaceOnUse', box: { x: 0, y: 0, width: 4, height: 1 } }))
      .not.toHaveProperty('aspect')
  })

  it('returns NULL for the eight kinds that are not gradients — the bridge stays', () => {
    for (const type of ['ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr', 'shader', 'shapes'] as const) {
      expect(paintToVectorPaint({ ...DEFAULT_FILL, type }, obb)).toBeNull()
    }
    expect(paintToVectorPaint(undefined, obb)).toBeNull()
    expect(paintToVectorPaint({ type: 'linear', angle: 0, stops: [] }, obb)).toBeNull()
  })

  it('emits the INVERSE of the referencing element\'s transform under userSpaceOnUse', () => {
    const g = paintToVectorPaint(RAMP, {
      units: 'userSpaceOnUse',
      box: { x: 0, y: 0, width: 10, height: 10 },
      elementTransform: [1, 0, 0, 1, 30, -7],
    }) as any
    expect(g.transform).toEqual([1, 0, 0, 1, -30, 7])
  })

  it('degrades to no transform on a singular one rather than writing NaN', () => {
    const g = paintToVectorPaint(RAMP, {
      units: 'userSpaceOnUse',
      box: { x: 0, y: 0, width: 10, height: 10 },
      elementTransform: [0, 0, 0, 0, 0, 0],
    }) as any
    expect(g.transform).toBeUndefined()
  })
})

// ── the adapter: the export must match what the canvas painted ──────────────

/** Parse an SVG transform list into an affine, composed HERE rather than with
 *  the spine's own multiply, so the check cannot pass by sharing a bug with the
 *  code it is checking.
 *
 *  `matrix` is in the alternation because the whole-run SHEAR is written as one
 *  — and a parser that silently skipped it would make every assertion below
 *  PASS on a skewed document while the `<path>` carried a transform nothing had
 *  checked. That is the shape of a test that agrees with itself. */
function parseTransform(list: string): Affine {
  const mul = (m: Affine, n: Affine): Affine => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
  let out: Affine = [1, 0, 0, 1, 0, 0]
  let seen = 0
  for (const m of list.matchAll(/(translate|rotate|scale|matrix)\(([^)]*)\)/g)) {
    const a = (m[2] as string).trim().split(/[\s,]+/).map(Number)
    seen++
    if (m[1] === 'translate') out = mul(out, [1, 0, 0, 1, a[0] as number, (a[1] ?? 0) as number])
    else if (m[1] === 'scale') out = mul(out, [a[0] as number, 0, 0, (a[1] ?? a[0]) as number, 0, 0])
    else if (m[1] === 'matrix') out = mul(out, a.slice(0, 6) as unknown as Affine)
    else {
      const r = ((a[0] as number) * Math.PI) / 180
      out = mul(out, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])
    }
  }
  // A list with a primitive this parser does not know is a list it has silently
  // half-read. Better to fail here than to "verify" a transform nobody parsed.
  expect(seen, `unparsed primitive in "${list}"`)
    .toBe((list.match(/[a-zA-Z]+\(/g) ?? []).length)
  return out
}

const paintedPaths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\/>/g)].map(m => m[0] as string)

describe('vectorTypeSVG — a gradient exports as a real paint server', () => {
  it('emits ONE gradient for a whole word, referenced by every glyph', () => {
    const { svg, frame } = vectorTypeSVG(font, cfg(), 0, BOX)
    expect(frame.outlines.glyphs.length).toBe(WORD.length)
    expect(count(svg, LINEARS)).toBe(1)
    expect(count(svg, /fill="url\(#/g)).toBe(WORD.length)
    expect(svg).toContain('<stop offset="0" stop-color="#ff0000"/>')
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff"/>')
  })

  it('a solid fill still exports as a plain attribute, with no <defs> at all', () => {
    const { svg } = vectorTypeSVG(font, cfg({ fill: { ...DEFAULT_FILL, a: '#ff2200' } }), 0, BOX)
    expect(svg).not.toContain('<defs>')
    expect(svg).toContain('fill="#ff2200"')
  })

  it('still degrades the eight non-gradient kinds to a flat colour — the bridge', () => {
    for (const type of ['ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr', 'shader', 'shapes'] as const) {
      const { svg } = vectorTypeSVG(font, cfg({ fill: { ...RAMP, type } }), 0, BOX)
      expect(svg).not.toContain('Gradient')
      expect(svg).toContain('fill="#ff0000"')
    }
  })
})

describe('vectorTypeSVG — gradientUnits follows the fill anchor', () => {
  it('glyph → objectBoundingBox, so each letter carries its own ramp', () => {
    const { svg } = vectorTypeSVG(font, cfg({ fillAnchor: 'glyph' }), 0, BOX)
    expect(svg).toContain('gradientUnits="objectBoundingBox"')
    expect(svg).not.toContain('userSpaceOnUse')
    expect(attr(svg, 'x1')).toBe('0')
    expect(attr(svg, 'x2')).toBe('1')
  })

  it('word → userSpaceOnUse over EXACTLY vtRunPaintBox, the box the canvas used', () => {
    const c = cfg({ fillAnchor: 'word' })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const frame = vectorTypeFrame(font, c, 0)
    const place = vtPlacement(frame, BOX)
    const box = vtRunPaintBox(frame.outlines, place, BOX)
    expect(svg).toContain('gradientUnits="userSpaceOnUse"')
    // angle 0 → left edge to right edge at the box's vertical centre.
    expect(Number(attr(svg, 'x1'))).toBeCloseTo(box.cx - box.w / 2, 2)
    expect(Number(attr(svg, 'x2'))).toBeCloseTo(box.cx + box.w / 2, 2)
    expect(Number(attr(svg, 'y1'))).toBeCloseTo(box.cy, 2)
  })

  it('frame → userSpaceOnUse over the whole output box', () => {
    const { svg } = vectorTypeSVG(font, cfg({ fillAnchor: 'frame' }), 0, BOX)
    expect(attr(svg, 'x1')).toBe('0')
    expect(attr(svg, 'x2')).toBe(String(BOX.width))
    expect(Number(attr(svg, 'y1'))).toBeCloseTo(BOX.height / 2, 6)
  })

  it('the three anchors write three GENUINELY different paint servers', () => {
    const defs = (a: 'glyph' | 'word' | 'frame') =>
      /<linearGradient[^>]*>/.exec(vectorTypeSVG(font, cfg({ fillAnchor: a }), 0, BOX).svg)?.[0] as string
    const [g, w, f] = [defs('glyph'), defs('word'), defs('frame')]
    expect(new Set([g, w, f]).size).toBe(3)
    expect(g).toContain('objectBoundingBox')
    expect(w).toContain('userSpaceOnUse')
    expect(f).toContain('userSpaceOnUse')
  })

  it('a bounding-box radial gets each glyph\'s OWN aspect correction', () => {
    const radial: Gradient = { type: 'radial', stops: TWO_STOPS }
    const c = cfg({ fill: radial as any, fillAnchor: 'glyph' })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const frame = vectorTypeFrame(font, c, 0)
    const place = vtPlacement(frame, BOX)
    const em = place.scale * (frame.outlines.unitsPerEm || 1000)
    // Distinct letterforms have distinct aspects, so they legitimately need
    // distinct corrections — but each must be the one its own ink box implies.
    const aspects = frame.outlines.glyphs.map(g => {
      const b = vtGlyphPaintBox(g, place, em)
      return b.w / b.h
    })
    const round5 = (v: number) => String(Math.round(v * 1e5) / 1e5)
    for (const a of aspects) {
      const sx = a >= 1 ? 1 : 1 / a
      const sy = a >= 1 ? a : 1
      expect(svg).toContain(`matrix(${[sx, 0, 0, sy, 0.5 * (1 - sx), 0.5 * (1 - sy)].map(round5).join(' ')})`)
    }
    // Distinct letterforms have distinct aspects, so they legitimately need
    // distinct corrections — one per DISTINCT aspect, never one per glyph.
    expect(count(svg, RADIALS)).toBe(new Set(aspects.map(a => Math.round(a * 1e5))).size)
  })

  it('corrects an OBLIQUE bounding-box ramp, and leaves an axis-aligned one plain', () => {
    // The one that a 0°/90° test cannot see: SVG stretches the unit square onto
    // the bbox, which tilts a 35° ramp's bands away from perpendicular while the
    // canvas keeps them square to the axis. Measured at 46.3 % of core ink
    // pixels wrong by >32/255 before this correction, 0.0000 % after.
    const at = (angle: number, aspect: number) =>
      shapesToSVG([{ commands: square(10, 10), fill: { type: 'linear', angle, stops: TWO_STOPS, aspect } }], DOC)
    for (const angle of [0, 90, 180, 270]) expect(at(angle, 2.5)).not.toContain('gradientTransform')
    expect(at(35, 1)).not.toContain('gradientTransform')
    const oblique = at(35, 2)
    const c = Math.cos((35 * Math.PI) / 180), s = Math.sin((35 * Math.PI) / 180)
    const round5 = (v: number) => String(Math.round(v * 1e5) / 1e5)
    expect(oblique).toContain(`matrix(${[c, s, -s / 2, c * 2, 0.5 - c / 2, 0.5 - s / 2].map(round5).join(' ')})`)
    // …with the ramp declared along the gradient space's own x axis.
    expect(oblique).toContain('x1="0" y1="0" x2="1" y2="0"')
  })

  it('shares ONE server across shapes whose aspect the markup does not use', () => {
    // An axis-aligned bounding-box ramp is the same element whatever the shape
    // is shaped like, so forty differently-proportioned glyphs must not each
    // get their own copy just because they passed a different aspect in.
    const svg = shapesToSVG([
      { commands: square(10, 10), fill: { type: 'linear', angle: 90, stops: TWO_STOPS, aspect: 0.3 } },
      { commands: square(30, 10), fill: { type: 'linear', angle: 90, stops: TWO_STOPS, aspect: 4.1 } },
    ], DOC)
    expect(count(svg, LINEARS)).toBe(1)
    expect(count(svg, /fill="url\(#/g)).toBe(2)
  })
})

describe('vectorTypeSVG — a run-anchored ramp stays PUT while the type moves', () => {
  it('cancels each glyph\'s own transform, exactly', () => {
    // spin-in gives every glyph a rotation AND a scale AND a translate, and the
    // stagger gives each a different one — the hardest case for the inverse.
    const c = mergeConfig({
      ...withPreset('spin-in', { fillAnchor: 'word' }),
      motion: {
        ...withPreset('spin-in', { fillAnchor: 'word' }).motion,
        stagger: { delay: 0.12, order: 'forward' },
      },
    })
    const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
    const paths = paintedPaths(svg)
    expect(paths.length).toBe(WORD.length)
    let checked = 0
    for (const path of paths) {
      const list = /transform="([^"]*)"/.exec(path)?.[1]
      const id = /fill="url\(#([^)]*)\)"/.exec(path)?.[1] as string
      const def = new RegExp(`<linearGradient id="${id}"[^>]*>`).exec(svg)?.[0] as string
      expect(def).toBeTruthy()
      const xf = /gradientTransform="matrix\(([^)]*)\)"/.exec(def)?.[1]
      if (!list) {
        // An untransformed glyph needs no correction at all.
        expect(xf).toBeUndefined()
        continue
      }
      const M = parseTransform(list)
      const G = (xf as string).trim().split(/\s+/).map(Number) as unknown as Affine
      // M · G must be the identity: the ramp is declared in document space and
      // then dragged back out of the glyph's own space.
      const id3 = multiplyAffine(M, G)
      expect(id3[0]).toBeCloseTo(1, 3)
      expect(id3[1]).toBeCloseTo(0, 3)
      expect(id3[2]).toBeCloseTo(0, 3)
      expect(id3[3]).toBeCloseTo(1, 3)
      expect(id3[4]).toBeCloseTo(0, 2)
      expect(id3[5]).toBeCloseTo(0, 2)
      checked++
    }
    expect(checked).toBeGreaterThan(1)
  })

  it('a STILL word under the same anchor still needs only one paint server', () => {
    // No motion, no transforms, so every glyph shares the ramp AND the (absent)
    // correction. The per-glyph transform is the only thing that can multiply
    // the defs, and it must not do so when there is no motion.
    const { svg } = vectorTypeSVG(font, cfg({ fillAnchor: 'word' }), 0, BOX)
    expect(count(svg, LINEARS)).toBe(1)
    expect(svg).not.toContain('gradientTransform')
    expect(count(svg, /fill="url\(#/g)).toBe(WORD.length)
  })

  it('under a GLYPH anchor the ramp is meant to ride the letter — no correction', () => {
    const { svg } = vectorTypeSVG(font, withPreset('spin-in', { fillAnchor: 'glyph' }), 0.5, BOX)
    expect(count(svg, LINEARS)).toBe(1)
    expect(svg).not.toContain('gradientTransform=')
    expect(svg).toMatch(/<path[^>]*transform="/)
  })

  // ── THE SHEAR CASE ────────────────────────────────────────────────────────
  //
  // The inverse of a rotate-and-scale is a rotate-and-scale; the inverse of a
  // SHEAR has off-diagonal terms that neither of the two mirrored writers had
  // ever produced before. This is the specific case `invertAffine` is most
  // likely to be subtly wrong in, so it is asserted on its own rather than left
  // to the general motion case above.
  it('cancels a SKEWED glyph\'s transform too — the off-diagonal inverse', () => {
    for (const skew of [{ skewX: 24 }, { skewY: -18 }, { skewX: 31, skewY: 22 }]) {
      const { svg } = vectorTypeSVG(font, cfg({ fillAnchor: 'word', ...skew }), 0, BOX)
      const paths = paintedPaths(svg)
      expect(paths.length).toBe(WORD.length)
      let checked = 0
      for (const path of paths) {
        const list = /transform="([^"]*)"/.exec(path)?.[1] as string
        // A skewed run gives EVERY glyph a transform, motion or no motion.
        expect(list, JSON.stringify(skew)).toBeTruthy()
        expect(list).toContain('matrix(')
        const id = /fill="url\(#([^)]*)\)"/.exec(path)?.[1] as string
        const def = new RegExp(`<linearGradient id="${id}"[^>]*>`).exec(svg)?.[0] as string
        const xf = /gradientTransform="matrix\(([^)]*)\)"/.exec(def)?.[1]
        expect(xf, `no gradientTransform under ${JSON.stringify(skew)}`).toBeTruthy()
        const M = parseTransform(list)
        const G = (xf as string).trim().split(/\s+/).map(Number) as unknown as Affine
        const id3 = multiplyAffine(M, G)
        expect(id3[0]).toBeCloseTo(1, 3)
        expect(id3[1]).toBeCloseTo(0, 3)
        expect(id3[2]).toBeCloseTo(0, 3)
        expect(id3[3]).toBeCloseTo(1, 3)
        expect(id3[4]).toBeCloseTo(0, 2)
        expect(id3[5]).toBeCloseTo(0, 2)
        checked++
      }
      expect(checked).toBe(WORD.length)
    }
  })

  it('the correction is REAL work — it is not the identity under skew', () => {
    // The failure this closes is the quiet one: an inverse that came back `null`
    // (a singular shear) drops the attribute, and every glyph then paints a ramp
    // that rides it. The test above would still see M · G ≈ I if G were the
    // identity and M were too, so the shear must be shown to be IN M.
    const { svg } = vectorTypeSVG(font, cfg({ fillAnchor: 'word', skewX: 30 }), 0, BOX)
    const list = /transform="([^"]*)"/.exec(paintedPaths(svg)[0] as string)?.[1] as string
    const M = parseTransform(list)
    // c = tan(30°): the shear is present and it is the requested one.
    expect(M[2]).toBeCloseTo(Math.tan(Math.PI / 6), 3)
    expect(M[0]).toBeCloseTo(1, 6)
    expect(M[3]).toBeCloseTo(1, 6)
    const xf = /gradientTransform="matrix\(([^)]*)\)"/.exec(svg)?.[1] as string
    const G = xf.trim().split(/\s+/).map(Number)
    // …and the correction carries the OFF-DIAGONAL term, which is exactly what a
    // rotate/scale inverse never had.
    expect(G[2]).toBeCloseTo(-Math.tan(Math.PI / 6), 3)
  })

  it('skew AND a stagger together — the hardest inverse in the studio', () => {
    // spin-in gives every glyph its own rotate + scale + translate; the shear is
    // composed on top of all of it, so M is a genuinely full matrix and every
    // glyph's is different.
    const c = mergeConfig({
      ...withPreset('spin-in', { fillAnchor: 'word', skewX: 22, skewY: -14 }),
      motion: {
        ...withPreset('spin-in', { fillAnchor: 'word', skewX: 22, skewY: -14 }).motion,
        stagger: { delay: 0.12, order: 'forward' },
      },
    })
    const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
    const seen = new Set<string>()
    let checked = 0
    for (const path of paintedPaths(svg)) {
      const list = /transform="([^"]*)"/.exec(path)?.[1] as string
      const id = /fill="url\(#([^)]*)\)"/.exec(path)?.[1] as string
      const def = new RegExp(`<linearGradient id="${id}"[^>]*>`).exec(svg)?.[0] as string
      const xf = /gradientTransform="matrix\(([^)]*)\)"/.exec(def)?.[1] as string
      seen.add(list)
      const id3 = multiplyAffine(parseTransform(list), xf.trim().split(/\s+/).map(Number) as unknown as Affine)
      expect(id3[0]).toBeCloseTo(1, 3)
      expect(id3[1]).toBeCloseTo(0, 3)
      expect(id3[2]).toBeCloseTo(0, 3)
      expect(id3[3]).toBeCloseTo(1, 3)
      expect(id3[4]).toBeCloseTo(0, 2)
      expect(id3[5]).toBeCloseTo(0, 2)
      checked++
    }
    expect(checked).toBe(WORD.length)
    // Not one shared transform being checked four times.
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('the export stays REAL vector', () => {
  it('carries no raster of any kind, with a gradient on every anchor', () => {
    for (const anchor of ['glyph', 'word', 'frame'] as const) {
      for (const t of [0, 0.5]) {
        const { svg } = vectorTypeSVG(font, withPreset('spin-in', { fillAnchor: anchor }), t, BOX)
        expect(svg).not.toContain('<image')
        expect(svg).not.toContain('base64')
        expect(svg).not.toContain('data:image')
        expect(svg).not.toContain('<feImage')
        expect(svg).toMatch(/<path d="M[^"]*[QC]/)
      }
    }
  })
})

describe('stroke paint servers — a gradient stroke is a real <linearGradient> referenced by url(#…)', () => {
  const grad = { type: 'linear' as const, x1: 0, y1: 0, x2: 1, y2: 0, stops: TWO_STOPS }
  it('writes stroke="url(#…)" and ONE gradient def shared by fill and stroke when they are equal', () => {
    const svg = shapesToSVG([
      { commands: square(10, 10, 30), fill: null, stroke: grad, strokeWidth: 1 },
      { commands: square(60, 10, 30), fill: grad, stroke: grad, strokeWidth: 1 },
    ], DOC)
    expect(count(svg, LINEARS)).toBe(1)
    expect(svg).toMatch(/stroke="url\(#[^"]+-g0\)"/)
    expect(svg).toMatch(/fill="url\(#[^"]+-g0\)"/)
    expect(svg).toContain('fill="none"')
  })
  it('a solid stroke string is written verbatim, as before', () => {
    const svg = shapesToSVG([{ commands: square(10, 10, 30), fill: null, stroke: '#ff0000', strokeWidth: 1 }], DOC)
    expect(svg).toContain('stroke="#ff0000"')
    expect(count(svg, LINEARS)).toBe(0)
  })
})
