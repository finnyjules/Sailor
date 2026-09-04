/**
 * Vector Type — the WHOLE-RUN shear (`skewX` / `skewY`).
 *
 * A shear is affine, so it is a legal SVG `transform` and this feature stays
 * exactly-correct vector. What that guarantee actually rests on is four things,
 * none of which a picture can check:
 *
 *  - **Whole-run, not per-glyph.** A shear about each glyph's OWN origin leans
 *    every letter while the word stays upright. Both pictures are "a slanted
 *    word" at a glance; only one of them is right. The wrong one is built here
 *    deliberately and shown to differ, so "it looked slanted" cannot pass.
 *  - **The two mirrored transform writers agree.** `glyphSvgTransform` writes a
 *    string and `glyphSvgMatrix` returns numbers, and the export's correctness
 *    depends on them being the same transform. The canvas's own `ctx` sequence
 *    is a THIRD writer of the same thing, composed independently below.
 *  - **The inverse survives.** A run-anchored gradient is pinned by
 *    `gradientTransform`, which holds the inverse of the element's transform. A
 *    shear's inverse has off-diagonal terms, and a SINGULAR shear has none at
 *    all — `invertAffine` refuses it and the pin silently disappears.
 *  - **Zero is free.** With both angles at 0 the run must be byte-identical to
 *    what it exported before the control existed.
 *
 * NO NETWORK: the same eight-character Inter variable subset the rest of the
 * Vector Type specs use.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  VT_SKEW_MAX,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
} from '~/lib/vectortype/config'
import {
  vectorTypeFrame,
  vectorTypeSVG,
  vtPlacement,
  vtIsSheared,
  vtRunPaintBox,
  vtRunShear,
} from '~/lib/vectortype/canvas'
import { glyphTransform, placeOutlines } from '~/lib/vectortype/render'
import { VT_CONTROLS } from '~/lib/vectortype/controls'
import { animatableTargets } from '~/lib/vectortype/motion'
import type { Affine, VectorCommand } from '~/lib/vector/svg'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()

/** The fixture only carries " Sailorg". */
const WORD = 'Sailor'
const BOX = { width: 480, height: 220 }

const cfg = (patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })

/** The frame + placement both renderers derive everything from. */
function scene(c: VectorTypeConfig, t = 0) {
  const frame = vectorTypeFrame(font, c, t)
  const place = vtPlacement(frame, BOX)
  return { frame, place, shear: vtRunShear(frame.config, frame.outlines, place, BOX) }
}

// ── independent affine arithmetic ───────────────────────────────────────────
//
// Written out here rather than imported, so nothing below can pass by sharing a
// bug with the code it is checking.

const mul = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const T = (x: number, y: number): Affine => [1, 0, 0, 1, x, y]
const apply = (m: Affine, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
const det = (m: Affine) => m[0] * m[3] - m[1] * m[2]
/** The shear itself, about a pivot — the thing under test, spelled out. */
const shearAbout = (kxDeg: number, kyDeg: number, px: number, py: number): Affine =>
  mul(mul(T(px, py), [1, Math.tan((kyDeg * Math.PI) / 180), Math.tan((kxDeg * Math.PI) / 180), 1, 0, 0]), T(-px, -py))

/** Every anchor point of a placed command list. */
function points(commands: readonly VectorCommand[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (const c of commands) {
    for (let i = 0; i + 1 < c.args.length; i += 2) out.push({ x: c.args[i] as number, y: c.args[i + 1] as number })
  }
  return out
}

const paintedPaths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\/>/g)].map(m => m[0] as string)

/** Parse an SVG transform list into an affine. Fails loudly on a primitive it
 *  does not know, rather than half-reading the list and passing. */
function parseTransform(list: string): Affine {
  let out: Affine = [1, 0, 0, 1, 0, 0]
  let seen = 0
  for (const m of list.matchAll(/(translate|rotate|scale|matrix)\(([^)]*)\)/g)) {
    const a = (m[2] as string).trim().split(/[\s,]+/).map(Number)
    seen++
    if (m[1] === 'translate') out = mul(out, T(a[0] as number, (a[1] ?? 0) as number))
    else if (m[1] === 'scale') out = mul(out, [a[0] as number, 0, 0, (a[1] ?? a[0]) as number, 0, 0])
    else if (m[1] === 'matrix') out = mul(out, a.slice(0, 6) as unknown as Affine)
    else {
      const r = ((a[0] as number) * Math.PI) / 180
      out = mul(out, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])
    }
  }
  expect(seen, `unparsed primitive in "${list}"`).toBe((list.match(/[a-zA-Z]+\(/g) ?? []).length)
  return out
}

// ── the config leaf ─────────────────────────────────────────────────────────

describe('skewX / skewY on the config', () => {
  it('defaults to no shear, and mergeConfig keeps a stored one', () => {
    expect(DEFAULT_CONFIG.skewX).toBe(0)
    expect(DEFAULT_CONFIG.skewY).toBe(0)
    expect(mergeConfig({ ...DEFAULT_CONFIG, skewX: 17.5, skewY: -3 }).skewX).toBe(17.5)
    expect(mergeConfig({ ...DEFAULT_CONFIG, skewX: 17.5, skewY: -3 }).skewY).toBe(-3)
  })

  it('lands a junk value on 0 rather than carrying NaN into the CTM', () => {
    const c = mergeConfig({ ...DEFAULT_CONFIG, skewX: 'sideways', skewY: null } as any)
    expect(c.skewX).toBe(0)
    expect(c.skewY).toBe(0)
  })

  it('is declared in Layout, animatable, over the bounded range', () => {
    for (const key of ['skewX', 'skewY']) {
      const spec = VT_CONTROLS.find(c => c.key === key)
      expect(spec, key).toBeTruthy()
      expect(spec!.group).toBe('Layout')
      expect(spec!.kind).toBe('slider')
      expect((spec as any).min).toBe(-VT_SKEW_MAX)
      expect((spec as any).max).toBe(VT_SKEW_MAX)
      // Motion is free here — `animatableTargets` admits any slider that does
      // not opt out, and a shear is a point on a scale rather than a mode.
      expect((spec as any).animatable).not.toBe(false)
    }
  })

  it('says out loud that a slant AXIS is the better tool', () => {
    // Plan step 4. The `slnt` hint has always said "a true oblique, not a
    // skew"; now that a skew slider exists, the pair must not read as two names
    // for one thing.
    const hint = String(VT_CONTROLS.find(c => c.key === 'skewX')!.hint)
    expect(hint).toMatch(/shear/i)
    expect(hint).toMatch(/slant/i)
    expect(hint).toMatch(/oblique/i)
  })
})

// ── the shear itself ────────────────────────────────────────────────────────

describe('vtRunShear — the ONE definition of the run transform', () => {
  it('is null at rest, so an unskewed run costs nothing', () => {
    expect(scene(cfg()).shear).toBeNull()
    expect(scene(cfg({ skewX: 0, skewY: 0 })).shear).toBeNull()
  })

  it('is exactly [1, tan(skewY), tan(skewX), 1] about the RUN ink centre', () => {
    const c = cfg({ skewX: 24, skewY: -11 })
    const { frame, place, shear } = scene(c)
    const box = vtRunPaintBox(frame.outlines, place, BOX)
    expect(shear).toBeTruthy()
    const want = shearAbout(24, -11, box.cx, box.cy)
    for (let i = 0; i < 6; i++) expect(shear![i]).toBeCloseTo(want[i] as number, 10)
    // The linear part is the requested shear, unrotated and unscaled.
    expect(shear![0]).toBe(1)
    expect(shear![3]).toBe(1)
    expect(shear![1]).toBeCloseTo(Math.tan((-11 * Math.PI) / 180), 12)
    expect(shear![2]).toBeCloseTo(Math.tan((24 * Math.PI) / 180), 12)
  })

  it('leaves the run ink CENTRE exactly where it was — that is the pivot', () => {
    const c = cfg({ skewX: 33, skewY: 27 })
    const { frame, place, shear } = scene(c)
    const box = vtRunPaintBox(frame.outlines, place, BOX)
    const moved = apply(shear!, box.cx, box.cy)
    expect(moved.x).toBeCloseTo(box.cx, 9)
    expect(moved.y).toBeCloseTo(box.cy, 9)
  })

  it('clamps to VT_SKEW_MAX, so a runaway motion track cannot go vertical', () => {
    const a = scene(cfg({ skewX: 5000 })).shear!
    const b = scene(cfg({ skewX: VT_SKEW_MAX })).shear!
    expect(a[2]).toBeCloseTo(b[2] as number, 12)
    expect(Number.isFinite(a[2])).toBe(true)
    expect(scene(cfg({ skewX: Number.NaN, skewY: Number.POSITIVE_INFINITY })).shear).toBeNull()
  })

  it('vtIsSheared answers EXACTLY what vtRunShear does, for every input', () => {
    // Two readings of "is there a shear" is one too many, and the second reader
    // is load-bearing: `vtPaintLayers` uses it to hand every layer
    // `spread: 'extend'`, because a leaning run overspills the axis-aligned
    // paint box its fill is anchored to. Measured before that landed: a
    // word-anchored gradient at `skewY: 22` painted 7,406 of the run's 10,673
    // ink pixels on canvas while the SVG painted all of them — 30.6 % of the
    // union simply absent, the top and bottom of the word cut off. If these two
    // predicates ever disagree, that comes back.
    const { frame, place } = scene(cfg())
    for (const pair of [
      [0, 0], [1, 0], [0, -1], [0.4, 0], [-0.4, 0.4], [1e-9, 0],
      [VT_SKEW_MAX, VT_SKEW_MAX], [1e6, 0], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY],
      [Number.NaN, 12],
    ]) {
      const c = { skewX: pair[0], skewY: pair[1] } as any
      expect(vtIsSheared(c), JSON.stringify(pair)).toBe(vtRunShear(c, frame.outlines, place, BOX) !== null)
    }
    expect(vtIsSheared(undefined)).toBe(false)
    expect(vtIsSheared({} as any)).toBe(false)
  })

  it('can NEVER be singular anywhere in the declared range', () => {
    // The trap `VT_SKEW_MAX` exists for: det = 1 − tan(skewX)·tan(skewY), which
    // is 0 along a curve that passes straight through 45°/45°. A singular run
    // transform collapses the word to a line AND makes `invertAffine` refuse,
    // which drops the pin off every run-anchored gradient in the document.
    const { frame, place } = scene(cfg())
    let worst = Infinity
    for (let kx = -VT_SKEW_MAX; kx <= VT_SKEW_MAX; kx += 1) {
      for (let ky = -VT_SKEW_MAX; ky <= VT_SKEW_MAX; ky += 1) {
        const s = vtRunShear({ skewX: kx, skewY: ky } as any, frame.outlines, place, BOX)
        if (!s) continue
        worst = Math.min(worst, Math.abs(det(s)))
      }
    }
    // 1 − tan(40°)² = 0.2959…
    expect(worst).toBeGreaterThan(0.29)
    // …and the bound is doing work rather than being decoration: five degrees
    // further out, the same pair of sliders IS singular.
    expect(1 - Math.tan((45 * Math.PI) / 180) ** 2).toBeCloseTo(0, 12)
  })
})

// ── whole-run, and the broken control that proves it ────────────────────────

describe('the shear is WHOLE-RUN (plan trap 4)', () => {
  /** Each glyph's element transform, from the exported document. */
  function elementTransforms(c: VectorTypeConfig, t = 0): Affine[] {
    const { svg } = vectorTypeSVG(font, c, t, BOX)
    return paintedPaths(svg).map((p) => {
      const list = /transform="([^"]*)"/.exec(p)?.[1]
      return list ? parseTransform(list) : ([1, 0, 0, 1, 0, 0] as Affine)
    })
  }

  it('gives every glyph the SAME matrix — one lean, not one lean each', () => {
    const ms = elementTransforms(cfg({ skewX: 26 }))
    expect(ms.length).toBe(WORD.length)
    const first = ms[0] as Affine
    for (const m of ms) for (let i = 0; i < 6; i++) expect(m[i]).toBeCloseTo(first[i] as number, 9)
  })

  it('BROKEN CONTROL: a per-glyph shear moves the ink somewhere else entirely', () => {
    // The wrong-looking one, built by hand: the same shear applied about each
    // glyph's own placed origin. Every letter leans identically and the word
    // does not, which at a glance is also "a slanted word".
    const c = cfg({ skewX: 26 })
    const { frame, place, shear } = scene(c)
    const placed = placeOutlines(frame.outlines, place)
    let maxDrift = 0
    let inked = 0
    for (let i = 0; i < placed.length; i++) {
      const origin = glyphTransform(frame.outlines.glyphs[i]!, place)
      const perGlyph = shearAbout(26, 0, origin.x, origin.y)
      for (const p of points(placed[i]!)) {
        const a = apply(shear!, p.x, p.y)
        const b = apply(perGlyph, p.x, p.y)
        maxDrift = Math.max(maxDrift, Math.hypot(a.x - b.x, a.y - b.y))
        inked++
      }
    }
    expect(inked).toBeGreaterThan(100)
    // Measured 18.0 output px apart at a 100 px em on a six-letter word — a
    // fifth of an em, not a rounding difference, and it grows with the word.
    expect(maxDrift).toBeGreaterThan(15)
  })

  it('skewY tilts the BASELINE across the word; a per-glyph shear would not', () => {
    // The crispest statement of the same thing. Under a whole-run shear each
    // glyph's placed origin picks up `tan(skewY)·(x − pivotX)`, so the run's
    // baseline rises across the word. Sheared about its own origin, a glyph's
    // origin is the fixed point and NOTHING moves.
    const c = cfg({ skewY: 20 })
    const { frame, place, shear } = scene(c)
    const ys = frame.outlines.glyphs.map((g) => {
      const o = glyphTransform(g, place)
      return apply(shear!, o.x, o.y).y - o.y
    })
    const rise = Math.max(...ys) - Math.min(...ys)
    expect(rise).toBeGreaterThan(40)
    // Strictly monotonic left to right — a lean, not a wobble.
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!)
  })
})

// ── the three writers say the same thing ────────────────────────────────────

describe('canvas and SVG are the same transform, written three times', () => {
  /**
   * The CANVAS sequence, composed here from `drawVectorType`'s own documented
   * ops — `ctx.transform(shear)` then the motion translate/rotate/scale — with
   * NO help from the code under test. This is the third independent writer.
   */
  function canvasCtm(shear: Affine | null, origin: { x: number; y: number }, advance: number, tr: any): Affine {
    let m: Affine = shear ?? [1, 0, 0, 1, 0, 0]
    const sx = tr.scale * (Number.isFinite(tr.scaleX) ? tr.scaleX : 1)
    const sy = tr.scale * (Number.isFinite(tr.scaleY) ? tr.scaleY : 1)
    if (tr.dx || tr.dy || tr.rotate || sx !== 1 || sy !== 1) {
      m = mul(m, T(origin.x + tr.dx, origin.y + tr.dy))
      if (tr.rotate) {
        const r = (tr.rotate * Math.PI) / 180
        m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])
      }
      if (sx !== 1 || sy !== 1) {
        m = mul(m, T(advance / 2, 0))
        m = mul(m, [sx, 0, 0, sy, 0, 0])
        m = mul(m, T(-advance / 2, 0))
      }
      m = mul(m, T(-origin.x, -origin.y))
    }
    return m
  }

  it('the exported transform IS the canvas CTM, at four skew settings', () => {
    for (const patch of [{ skewX: 12 }, { skewX: -37 }, { skewY: 25 }, { skewX: 18, skewY: -18 }]) {
      const c = cfg(patch)
      const { frame, place, shear } = scene(c)
      const { svg } = vectorTypeSVG(font, c, 0, BOX)
      const paths = paintedPaths(svg)
      expect(paths.length, JSON.stringify(patch)).toBe(WORD.length)
      paths.forEach((p, i) => {
        const list = /transform="([^"]*)"/.exec(p)?.[1] as string
        const svgM = parseTransform(list)
        const glyph = frame.outlines.glyphs[i]!
        const want = canvasCtm(shear, glyphTransform(glyph, place), glyph.advance * place.scale, frame.transforms[i] ?? {
          dx: 0, dy: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1,
        })
        for (let k = 0; k < 6; k++) {
          expect(svgM[k], `${JSON.stringify(patch)} glyph ${i} term ${k}`).toBeCloseTo(want[k] as number, 3)
        }
      })
    }
  })

  it('the ink lands in the same place in both, to the file\'s own precision', () => {
    // `placeOutlines` is the choke point both renderers consume, so the SVG's
    // path data must be those points and the element transform must put them
    // where the canvas's CTM puts them.
    //
    // The residual is the FILE's rounding and nothing else, which is why the
    // tolerance is derived from `precision` rather than picked: at 3 decimal
    // places the matrix's `c` term is off by up to 5e-4 and it multiplies a y
    // of a couple of hundred px, so ~0.1 px. Ask for 6 places and it collapses
    // to a thousandth of a pixel — that is what proves it is rounding rather
    // than a second, drifting derivation.
    const c = cfg({ skewX: 28, skewY: -9 })
    const { frame, place, shear } = scene(c)
    const placed = placeOutlines(frame.outlines, place)
    for (const [precision, tol] of [[3, 0.15], [6, 0.001]] as const) {
      const { svg } = vectorTypeSVG(font, c, 0, { ...BOX, precision })
      const paths = paintedPaths(svg)
      let compared = 0
      let worst = 0
      paths.forEach((p, i) => {
        const svgM = parseTransform(/transform="([^"]*)"/.exec(p)?.[1] as string)
        const d = /\bd="([^"]*)"/.exec(p)?.[1] as string
        const nums = d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!.map(Number)
        const mine = points(placed[i]!)
        expect(nums.length).toBe(mine.length * 2)
        for (let k = 0; k < mine.length; k++) {
          const a = apply(svgM, nums[k * 2] as number, nums[k * 2 + 1] as number)
          const b = apply(shear!, mine[k]!.x, mine[k]!.y)
          worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y))
          compared++
        }
      })
      expect(compared).toBeGreaterThan(100)
      expect(worst, `precision ${precision}`).toBeLessThan(tol)
    }
  })

  it('writes NOTHING when there is no skew and no motion — zero is free', () => {
    const plain = vectorTypeSVG(font, cfg(), 0, BOX).svg
    expect(plain).not.toContain('transform=')
    expect(plain).not.toContain('matrix(')
    // …and the skewed document differs, so the assertion above is not vacuous.
    expect(vectorTypeSVG(font, cfg({ skewX: 15 }), 0, BOX).svg).toContain('matrix(')
  })

  it('a skewed export is still REAL vector — paths, no raster, no CSS transform', () => {
    const { svg } = vectorTypeSVG(font, cfg({ skewX: 30, skewY: 12 }), 0, BOX)
    expect(svg).toMatch(/<path d="M[^"]*[QC]/)
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('data:image')
    // A CSS `style="transform:…"` is a rendering instruction, not geometry, and
    // does not round-trip to an editor. The shear is an SVG attribute.
    expect(svg).not.toMatch(/style="[^"]*transform/)
  })

  it('ANIMATES — a motion track on skewX moves the run, free of any new plumbing', () => {
    // The reason this costs nothing: `drawVectorType` and `vectorTypeSVG` both
    // build the shear from `frame.config`, which is the POST-motion config, and
    // Vector Type is `f(cfg, t) → paths` with no engine to rebuild. So the
    // target being offered and the shear moving are the same fact.
    expect(animatableTargets(cfg()).map(t => t.path)).toContain('skewX')
    const c = mergeConfig({
      ...cfg(),
      motion: {
        ...cfg().motion,
        // The moves-shaped equivalent of the old flat `motion.tracks` entry: one
        // `kind: 'tracks'` move, `ease: 'none'`/`loop: false` (a one-shot
        // transition) so the progress is pure LINEAR t/D — exactly what the old
        // (unlabelled) track defaulted to.
        moves: [{
          id: 'move-skew',
          at: 0,
          kind: 'tracks',
          presetId: 'custom',
          duration: cfg().motion.duration,
          loop: false,
          ease: { kind: 'named', name: 'none' },
          tracks: [{ path: 'skewX', from: 0, to: 30, hold: 0, cycleOffset: 0, delay: 0 }],
        }],
      },
    })
    // The track's span is the MOTION BLOCK's duration, not a per-track one.
    const D = c.motion.duration
    const at = (t: number) => {
      const f = vectorTypeFrame(font, c, t)
      return vtRunShear(f.config, f.outlines, vtPlacement(f, BOX), BOX)
    }
    expect(at(0)).toBeNull()
    const seen = [0.25, 0.5, 0.75, 1].map(k => at(k * D)![2] as number)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
    expect(seen[0]).toBeCloseTo(Math.tan((7.5 * Math.PI) / 180), 6)
    expect(seen[3]).toBeCloseTo(Math.tan((30 * Math.PI) / 180), 6)
  })

  it('survives the appearance stack — a stroke and an extrude lean with the run', () => {
    const c = cfg({
      skewX: 22,
      appearance: [
        vtLayer({ id: 'Lex', kind: 'extrude', depth: 4, distance: 6, angle: 135 }),
        vtLayer({ id: 'Lfill' }),
        vtLayer({ id: 'Lstroke', kind: 'stroke', width: 3, paint: '#ff0055' }),
      ],
    })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const lists = paintedPaths(svg).map(p => /transform="([^"]*)"/.exec(p)?.[1] as string)
    // 4 extrude copies + 1 fill + 1 stroke per glyph, every one of them sheared.
    expect(lists.length).toBe(WORD.length * 6)
    const tan = Math.tan((22 * Math.PI) / 180)
    for (const list of lists) expect(parseTransform(list)[2]).toBeCloseTo(tan, 3)
  })
})
