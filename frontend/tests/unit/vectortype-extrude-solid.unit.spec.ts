/**
 * Vector Type — the SOLID extrude: the offset copies fused into ONE body.
 *
 * Four things this spec is trying to be evidence for, in order of how easy each
 * would be to fake:
 *
 *  1. **The union really unions.** paper.js runs here for real — it needs no
 *     canvas and no DOM, which is the whole reason `useVectorSvg.ts`'s headless
 *     `PaperScope` pattern was worth copying — so "one body" is asserted as a
 *     SUBPATH COUNT and an AREA, not as "it rendered something". Two overlapping
 *     10×10 squares must come back as one contour of area 175, and a glyph's
 *     eight copies as one contour where the un-unioned stack has eight.
 *  2. **Its SVG is one `<path>`.** The claim that makes this feature worth doing
 *     at all is a file a designer opens: `shapesToSVG` over the body emits ONE
 *     `<path>` element where the copies emit `depth` of them. Counted, not
 *     described.
 *  3. **It cannot run in a draw loop** (plan trap 5). Three independent
 *     assertions, because a comment is not a constraint: the render path's
 *     transitive import graph never reaches `paper`; `drawVectorType` is
 *     synchronous, so it could not await a union if it wanted to; and a
 *     `solid: true` extrude drawn with no precomputed bodies draws the FULL
 *     un-unioned stack, which is what every live frame does.
 *  4. **One derivation of where a copy goes.** `extrudeCopyTransform` is what
 *     the canvas steps its copies with AND what the union steps its copies with.
 *     A test solves the canvas's own emitted matrices back and demands they be
 *     the identical numbers — a union that disagreed with the preview by a pixel
 *     would still look like a solid extrude, just not the one on the screen.
 *
 * NO NETWORK, NO DOM: the same eight-character Inter variable subset every other
 * Vector Type spec uses, plus `Path2D`/`DOMMatrix` stubs (this suite runs in
 * node). paper.js is the one real dependency and it runs headless.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commandsToPathData, shapesToSVG, transformCommands, type VectorCommand } from '~/lib/vector/svg'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
} from '~/lib/vectortype/config'
import {
  extrudeCopyTransform,
  extrudeOffsets,
  vtSolidKey,
  type VtExtrudeCopy,
  type VtSolidBodies,
} from '~/lib/vectortype/extrude'
import {
  clearSolidExtrudeCache,
  prepareSolidExtrudes,
  solidExtrudeBody,
  subpathCount,
  unionCommandLists,
} from '~/lib/vectortype/extrudeSolid'
import { drawVectorType, vectorTypeFrame, vtPlacement, vtSolidExtrudeLayers } from '~/lib/vectortype/canvas'
import { glyphTransform as glyphPlacement, placeOutlines } from '~/lib/vectortype/render'
import { textOutlines } from '~/lib/vectortype/outline'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
const APP = fileURLToPath(new URL('../../app/', import.meta.url))

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
const N = WORD.length
const BOX = { width: 400, height: 200 }
const RED = '#ff0000'
const BLUE = '#0000ff'

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}
function stack(...layers: Partial<VtAppearanceLayer>[]): VectorTypeConfig {
  return cfg({ appearance: layers.map((l, i) => vtLayer({ id: `L${i}`, ...l })) })
}

/** A closed axis-aligned square as a command list — the shape whose union area
 *  can be computed by hand, so "the union unioned" is arithmetic. */
const square = (x: number, y: number, w: number): VectorCommand[] => [
  { command: 'moveTo', args: [x, y] },
  { command: 'lineTo', args: [x + w, y] },
  { command: 'lineTo', args: [x + w, y + w] },
  { command: 'lineTo', args: [x, y + w] },
  { command: 'closePath', args: [] },
]

/** The signed area of a command list's polygon, by the shoelace over its
 *  vertices. Exact for the squares above (they are polygons); used only on
 *  those, never on a glyph. */
function polygonArea(commands: readonly VectorCommand[]): number {
  const pts: Array<[number, number]> = []
  for (const c of commands) {
    if (c.command === 'closePath') continue
    const a = c.args
    pts.push([a[a.length - 2] as number, a[a.length - 1] as number])
  }
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!
    s += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(s) / 2
}

/**
 * Bounds of a command list's ON-CURVE points.
 *
 * Deliberately not `controlPointBounds`: a boolean union re-fits the contour, so
 * the OUTPUT's bezier handles are not the input's and a control-point box is an
 * overestimate that differs on each side of the comparison. Every command's last
 * two args are its endpoint, on the curve, on both sides.
 */
function pointBounds(cmds: readonly VectorCommand[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of cmds) {
    const a = c.args
    if (a.length < 2) continue
    const x = a[a.length - 2] as number
    const y = a[a.length - 1] as number
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/** The placed command list of one glyph of `WORD`, in output space — the exact
 *  geometry the renderer copies. */
function placedGlyph(index: number): VectorCommand[] {
  const outlines = textOutlines(font, WORD)
  return placeOutlines(outlines, { scale: 0.1, x: 0, y: 0 })[index] as VectorCommand[]
}

// ════════════════════════════════════════════════════════════════════════════
// 1. `extrudeCopyTransform` — the ONE derivation of where a copy goes
// ════════════════════════════════════════════════════════════════════════════

describe('extrudeCopyTransform — one derivation, three surfaces', () => {
  const origin = { x: 40, y: 120 }
  const advance = 60

  it('is a BARE translate for an untapered copy — exactly, with no pivot noise', () => {
    // The overwhelmingly common case. The folded form adds `pivot × (1 - s)`,
    // which at s = 1 must be exactly 0 and not 1e-16: a copy that landed a
    // billionth of a pixel off would make the union's coincident edges stop
    // coinciding, and paper would return a hairline sliver instead of a seam.
    const t = extrudeCopyTransform({ dx: 12, dy: -7, scale: 1 }, origin, advance)
    expect(t).toEqual({ scale: 1, rotate: 0, x: 12, y: -7, flipY: false })
  })

  it('scales a tapered copy about the CELL CENTRE and the BASELINE', () => {
    const c: VtExtrudeCopy = { dx: 0, dy: 0, scale: 0.5 }
    const t = extrudeCopyTransform(c, origin, advance)
    // Solve the fold back for the pivot it scaled about: x = dx + px(1-s).
    expect(t.x / (1 - t.scale)).toBeCloseTo(origin.x + advance / 2, 12)
    expect(t.y / (1 - t.scale)).toBeCloseTo(origin.y, 12)
    // The cell CENTRE, not the left edge — a left-edge pivot would give 40.
    expect(t.x / (1 - t.scale)).toBeCloseTo(70, 12)
  })

  it('never flips y — the flip is already baked into the placed coordinates', () => {
    // `render.ts` bakes the y-flip into the commands long before a copy is
    // taken. A copy that flipped again would draw the extrude upside-down
    // behind an upright face: a picture that still looks like an extrude.
    for (const scale of [1, 0.4, 1.8]) {
      expect(extrudeCopyTransform({ dx: 3, dy: 4, scale }, origin, advance).flipY).toBe(false)
    }
  })

  it('is the SAME arithmetic the CANVAS steps its copies with', () => {
    // The anti-drift assertion, and the reason this function exists at all.
    // With no motion and `pixelRatio` 1 the glyph's own CTM is the identity, so
    // the transform each copy is FILLED under is exactly the copy transform —
    // which lets the renderer's numbers be compared to the union's directly
    // rather than through a solved-back pivot. Both call this function today; if
    // a future edit re-derives a copy step inside `canvas.ts`, this goes red
    // before the union and the preview can disagree in a bake.
    const layer = { kind: 'extrude' as const, paint: BLUE, depth: 4, distance: 10, angle: 30, taper: 0.5 }
    const { ctx, frame } = draw(stack(layer))
    const copies = extrudeOffsets(layer as unknown as VtAppearanceLayer)
    expect(copies.length).toBe(4)
    expect(ctx.paints.length).toBe(4 * N)

    const place = vtPlacement(frame, BOX)
    for (let i = 0; i < N; i++) {
      const glyph = frame.outlines.glyphs[i]!
      const origin = glyphPlacement(glyph, place)
      const advance = glyph.advance * place.scale
      copies.forEach((c, k) => {
        const t = extrudeCopyTransform(c, origin, advance)
        expect(ctx.paints[i * 4 + k]!.m, `glyph ${i} copy ${k}`)
          .toEqual([t.scale, 0, 0, t.scale, t.x, t.y])
      })
    }
  })

  it('falls back rather than propagating NaN into a transform', () => {
    const t = extrudeCopyTransform({ dx: NaN, dy: undefined as unknown as number, scale: NaN }, origin, advance)
    expect(t).toEqual({ scale: 1, rotate: 0, x: 0, y: 0, flipY: false })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. The union itself — real paper.js, headless
// ════════════════════════════════════════════════════════════════════════════

describe('unionCommandLists — paper.js, headless, for real', () => {
  it('fuses two overlapping squares into ONE contour of the right AREA', async () => {
    // 100 + 100 − 25 = 175. A UNION, not a concatenation: two shapes merely
    // appended would still be "one command list" and would still fill, but the
    // overlap would be counted twice and the outline would be two loops — the
    // exact thing this feature exists to stop. 150 would mean the overlap
    // cancelled to a hole; 200 would mean nothing was fused at all.
    const out = await unionCommandLists([square(0, 0, 10), square(5, 5, 10)])
    expect(subpathCount(out)).toBe(1)
    expect(polygonArea(out)).toBeCloseTo(175, 6)
  })

  it('keeps DISJOINT copies as one command list with one subpath each', async () => {
    // Two squares that never touch cannot become one contour, and pretending
    // otherwise would bridge them with a phantom edge. They are still ONE body
    // in the sense that matters — one command list, one `<path>`, one fill.
    const out = await unionCommandLists([square(0, 0, 10), square(100, 100, 10)])
    expect(subpathCount(out)).toBe(2)
  })

  it('returns the single input UNCHANGED rather than paying paper for nothing', async () => {
    const one = square(3, 4, 5)
    const out = await unionCommandLists([one])
    expect(out).toEqual(one)
    // …and a copy, not the caller's array: a body handed straight back and then
    // mutated by a renderer would corrupt the glyph it came from.
    expect(out).not.toBe(one)
    expect(out[0]).not.toBe(one[0])
  })

  it('returns [] for nothing to unite, and never throws', async () => {
    expect(await unionCommandLists([])).toEqual([])
    expect(await unionCommandLists([[]])).toEqual([])
    expect(await unionCommandLists([[{ command: 'moveTo', args: [0, 0] }]])).toEqual([])
  })

  it('fuses a GLYPH’s offset copies into ONE body — 8 subpaths become 1', async () => {
    // 'S' has no counter, so its outline is a single contour and eight
    // overlapping copies of it must fuse to exactly one. This is the headline
    // number of the whole task.
    const g = placedGlyph(0) // 'S'
    expect(subpathCount(g)).toBe(1)
    const copies = extrudeOffsets({ depth: 8, angle: 45, distance: 3, taper: 0 } as VtAppearanceLayer)
    expect(copies.length).toBe(8)

    const body = await solidExtrudeBody(g, copies, { x: 0, y: 0 }, 55)
    expect(subpathCount(body)).toBe(1)
    // The fused body spans EXACTLY from the NEAREST copy's near edge to the
    // FARTHEST copy's far edge — the outline of the swept mass, to three
    // decimals. Two independent things fail if this is off:
    //
    //  - its left edge is the glyph's plus copy 1's step, NOT the glyph's own.
    //    There is no copy at offset zero (the face is a separate layer), so a
    //    union that helpfully included the un-stepped glyph would start 2.12px
    //    further left and quietly make a solid extrude bigger than the stack it
    //    replaces.
    //  - its right edge is the glyph's plus copy 8's step, so nothing was
    //    dropped off the far end — a union that returned only the first copy, or
    //    that stopped accumulating early, lands short here.
    const one = pointBounds(g)
    const all = pointBounds(body)
    const near = copies[copies.length - 1] as VtExtrudeCopy // k = 1
    const far = copies[0] as VtExtrudeCopy                  // k = depth
    expect(near.dx).toBeCloseTo(3 * Math.SQRT1_2, 6)
    expect(far.dx).toBeCloseTo(8 * 3 * Math.SQRT1_2, 6)
    expect(all.x0).toBeCloseTo(one.x0 + near.dx, 3)
    expect(all.x1).toBeCloseTo(one.x1 + far.dx, 3)
    expect(all.y0).toBeCloseTo(one.y0 + near.dy, 3)
    expect(all.y1).toBeCloseTo(one.y1 + far.dy, 3)
  })

  it('keeps a glyph’s COUNTER as a hole inside the one body', async () => {
    // 'a' has a counter. One body does not mean one contour: a solid extrude of
    // a letter with a hole still has the hole (whatever of it survives the
    // copies filling it in), carried as a second subpath under `nonzero` —
    // exactly as the un-unioned glyph carries it.
    const a = placedGlyph(1) // 'a'
    expect(subpathCount(a)).toBeGreaterThan(1)
    const body = await solidExtrudeBody(a, extrudeOffsets({ depth: 3, angle: 0, distance: 1 } as VtAppearanceLayer), { x: 0, y: 0 }, 55)
    // Still ONE command list (one `<path>`, one fill) — see the SVG test below.
    expect(body.length).toBeGreaterThan(0)
    expect(subpathCount(body)).toBeGreaterThan(1)
  })

  it('has NOT leaked a global PaperScope or created a canvas', async () => {
    await unionCommandLists([square(0, 0, 10), square(5, 5, 10)])
    // `useVectorSvg.ts`'s rule, asserted rather than trusted: the module holds
    // its OWN detached scope, so paper's global (`paper.project`, the thing a
    // `paper.setup(canvasEl)` would populate) is never installed on the app.
    expect((globalThis as any).paper).toBeUndefined()
    expect((globalThis as any).document).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. ONE `<path>` — the observable difference, counted
// ════════════════════════════════════════════════════════════════════════════

describe('the SVG of a solid extrude is ONE <path>, not N overlapping ones', () => {
  const paths = (svg: string) => (svg.match(/<path\b/g) ?? []).length

  it('emits 1 where the un-unioned stack emits `depth`', async () => {
    const g = placedGlyph(0)
    const copies = extrudeOffsets({ depth: 8, angle: 45, distance: 3 } as VtAppearanceLayer)
    const stackedSvg = shapesToSVG(
      copies.map(c => ({ commands: transformCommands(g, extrudeCopyTransform(c, { x: 0, y: 0 }, 55)), fill: BLUE })),
      { viewBox: [0, 0, 400, 200] },
    )
    const body = await solidExtrudeBody(g, copies, { x: 0, y: 0 }, 55)
    const solidSvg = shapesToSVG([{ commands: body, fill: BLUE }], { viewBox: [0, 0, 400, 200] })

    expect(paths(stackedSvg)).toBe(8)
    expect(paths(solidSvg)).toBe(1)
    // And the one path is not a stub: it carries a real `d` of comparable size
    // to the eight it replaced, because it is their outline.
    expect(commandsToPathData(body).length).toBeGreaterThan(200)
  })

  it('is still ONE <path> for a glyph with a counter', async () => {
    const a = placedGlyph(1)
    const body = await solidExtrudeBody(a, extrudeOffsets({ depth: 6, angle: 0, distance: 2 } as VtAppearanceLayer), { x: 0, y: 0 }, 55)
    const svg = shapesToSVG([{ commands: body, fill: BLUE }], { viewBox: [0, 0, 400, 200] })
    expect(paths(svg)).toBe(1)
    // The hole rides INSIDE that one path as a second `M` — subpaths, not
    // shapes. `nonzero` is what makes it a hole, and that is the fill rule both
    // renderers already use for glyph counters.
    expect((commandsToPathData(body).match(/M/g) ?? []).length).toBeGreaterThan(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. TRAP 5 — the union cannot be reached from a draw loop
// ════════════════════════════════════════════════════════════════════════════

/**
 * Every module specifier a file imports — `from '…'`, a dynamic `import('…')`
 * AND a bare side-effect `import '…'`.
 *
 * The third form is not padding: a bare `import 'paper'` is exactly how a future
 * edit would pull the geometry library into the render path without any symbol
 * appearing in the diff, and the first version of this test missed it. Found by
 * deliberately adding one and watching the test stay green.
 */
function specifiersOf(source: string): string[] {
  // A type-only import is erased by the compiler: it is not a runtime edge and can drag
  // nothing into a bundle. Without this the walk reported paper reachable from Vector Type
  // through `motion/types.ts -> import type … effectTracks -> import type … useCompositorLayers`
  // — two erased edges — once the Frame's effect tracks (F8) joined the motion types.
  // (`import { type A, b }` is a real import and is still followed.)
  const src = source.replace(/\b(?:import|export)\s+type\s+[^;'"]*?\bfrom\s+'[^']+'/g, '')
  const out: string[] = []
  for (const m of src.matchAll(/\bfrom\s+'([^']+)'/g)) out.push(m[1] as string)
  for (const m of src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) out.push(m[1] as string)
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) out.push(m[1] as string)
  return out
}

/** Resolve an app-relative specifier to a file on disk, or null for a package. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('~/')) base = resolvePath(APP, spec.slice(2))
  else if (spec.startsWith('.')) base = resolvePath(dirname(fromFile), spec)
  else return null // a bare package — 'paper', 'fontkit', 'three'…
  for (const ext of ['.ts', '.vue', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

describe('trap 5 — the render path cannot reach the union', () => {
  it('never reaches `paper` from canvas.ts, transitively', () => {
    // The structural half of the boundary. A comment saying "do not call this
    // per frame" is advice; an import graph that does not contain paper.js is a
    // fact, and this test is what turns a future `import { unionCommandLists }`
    // in the renderer into a red build rather than a slow one.
    const start = resolvePath(APP, 'lib/vectortype/canvas.ts')
    const seen = new Set<string>()
    const queue = [start]
    const offenders: string[] = []
    while (queue.length) {
      const file = queue.shift() as string
      if (seen.has(file)) continue
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      for (const spec of specifiersOf(src)) {
        if (spec === 'paper' || spec.startsWith('paper/')) offenders.push(`${file} -> ${spec}`)
        const next = resolveSpec(spec, file)
        if (next && !seen.has(next)) queue.push(next)
      }
    }
    expect(offenders).toEqual([])
    // The graph really was walked — not an empty set that trivially passes.
    expect(seen.size).toBeGreaterThan(10)
    // And it did NOT include the union module, which is the file paper lives in.
    expect([...seen].some(f => f.endsWith('extrudeSolid.ts'))).toBe(false)
  })

  it('is unreachable a second way: `drawVectorType` is SYNCHRONOUS', () => {
    // Even if the import existed, a sync function cannot await a union. The
    // renderer's only way in is a map somebody else already resolved.
    const { ctx } = draw(stack({ kind: 'extrude', paint: BLUE, depth: 3, distance: 5, solid: true }))
    expect(ctx.paints.length).toBeGreaterThan(0)
    const out = drawVectorType(new RecCtx() as unknown as CanvasRenderingContext2D, font, cfg(), 0, BOX)
    expect(out).not.toBeInstanceOf(Promise)
    expect(typeof (out as any).then).toBe('undefined')
  })

  it('draws the FULL un-unioned stack when no bodies were handed in', () => {
    // The live path, and the one that must never change: `solid: true` with no
    // precomputed geometry is `depth` copies, exactly as `solid: false` is.
    //
    // "NO precomputed geometry" now has a second source. Since the paper-free
    // body cache landed, `drawVectorType` also PEEKS at bodies somebody else
    // united (`extrudeBodyCache.ts`) — a `Map.get`, never a computation. So the
    // premise is made explicit rather than assumed: with the store empty, this
    // asserts exactly the property it always did, and it no longer depends on
    // which describe block ran first.
    clearSolidExtrudeCache()
    const solidCfg = stack({ kind: 'extrude', paint: BLUE, depth: 6, distance: 4, angle: 0, solid: true })
    const looseCfg = stack({ kind: 'extrude', paint: BLUE, depth: 6, distance: 4, angle: 0, solid: false })
    const a = draw(solidCfg).ctx.paints.length
    const b = draw(looseCfg).ctx.paints.length
    expect(a).toBe(6 * N)
    expect(a).toBe(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. The bake path — a handed-in body REPLACES the copies
// ════════════════════════════════════════════════════════════════════════════

describe('a precomputed body replaces the copies, and is addressed by ID', () => {
  /** A recognisable body: one triangle, so its `moveTo` is unmistakable. */
  const BODY: VectorCommand[] = [
    { command: 'moveTo', args: [1, 2] },
    { command: 'lineTo', args: [3, 4] },
    { command: 'lineTo', args: [5, 6] },
    { command: 'closePath', args: [] },
  ]
  const bodies = (id: string, n = N): VtSolidBodies => {
    const m = new Map<string, VectorCommand[]>()
    for (let i = 0; i < n; i++) m.set(vtSolidKey(id, i), BODY)
    return m
  }
  const extrude = { kind: 'extrude' as const, paint: BLUE, depth: 6, distance: 4, angle: 0, solid: true }

  it('draws ONE fill per glyph instead of `depth`, and draws the BODY', () => {
    const { ctx } = draw(stack(extrude), 0, { solid: bodies('L0') })
    expect(ctx.paints.length).toBe(N) // not 6 × N
    // …and what it filled is the body, not the glyph: every paint replayed the
    // triangle. A renderer that drew the glyph path once would also give N
    // paints, so the count alone is not enough.
    for (const p of ctx.paints) expect(p.cmds?.[0]?.args).toEqual([1, 2])
  })

  it('leaves a NON-solid extrude on the copies even when a body exists for it', () => {
    // The flag is the switch, not the presence of geometry. A stale map from an
    // earlier config must not silently fuse an extrude the user un-fused.
    const { ctx } = draw(stack({ ...extrude, solid: false }), 0, { solid: bodies('L0') })
    expect(ctx.paints.length).toBe(6 * N)
  })

  it('falls back to the copies when the map has no body for the layer', () => {
    // The id is wrong (a reorder, a stale bake, a hand-written blob with no id).
    // The fallback is the picture the live preview already shows — visible and
    // recoverable, never a blank or a throw.
    const { ctx } = draw(stack(extrude), 0, { solid: bodies('SOMEONE-ELSE') })
    expect(ctx.paints.length).toBe(6 * N)
  })

  it('addresses the body by the layer’s stable ID, not its stack position', () => {
    // Trap 2, one level down. The extrude moves from slot 0 to slot 1 and keeps
    // its id; a map keyed by index would now fuse the FILL layer's slot.
    const under = stack(extrude, { kind: 'fill', paint: RED })
    const over = cfg({
      appearance: [vtLayer({ id: 'F', kind: 'fill', paint: RED }), vtLayer({ id: 'L0', ...extrude })],
    })
    for (const c of [under, over]) {
      const { ctx } = draw(c, 0, { solid: bodies('L0') })
      // one body fill per glyph for the extrude + one ordinary fill per glyph.
      expect(ctx.paints.length).toBe(2 * N)
      // The triangle body is 4 commands; a real glyph path is dozens.
      expect(ctx.paints.filter(p => p.cmds?.length === BODY.length).length).toBe(N)
    }
  })

  it('composes the layer’s own opacity and blend over the body, as over a copy', () => {
    const { ctx } = draw(
      stack({ ...extrude, opacity: 0.5, blend: 'multiply' }), 0, { solid: bodies('L0') },
    )
    expect(ctx.paints.length).toBe(N)
    for (const p of ctx.paints) {
      expect(p.alpha).toBeCloseTo(0.5, 10)
      expect(p.gco).toBe('multiply')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. `prepareSolidExtrudes` — the one entry point a bake calls
// ════════════════════════════════════════════════════════════════════════════

describe('prepareSolidExtrudes — the bake entry point', () => {
  it('returns an EMPTY map, and touches no paper, when nothing is solid', async () => {
    // The common case, and it must be free: an ordinary config baking a PNG
    // pays one stack walk and never loads a 300kb geometry library.
    const out = await prepareSolidExtrudes(font, stack({ kind: 'fill', paint: RED }), 0, BOX)
    expect(out.size).toBe(0)
    const notSolid = await prepareSolidExtrudes(
      font, stack({ kind: 'extrude', paint: BLUE, depth: 8, solid: false }), 0, BOX)
    expect(notSolid.size).toBe(0)
  })

  it('returns one body per (solid layer, inked glyph), keyed by vtSolidKey', async () => {
    const c = stack({ kind: 'extrude', paint: BLUE, depth: 5, distance: 4, angle: 0, solid: true })
    const out = await prepareSolidExtrudes(font, c, 0, BOX)
    expect(out.size).toBe(N)
    for (let i = 0; i < N; i++) {
      const body = out.get(vtSolidKey('L0', i))
      expect(body, `glyph ${i}`).toBeTruthy()
      expect(subpathCount(body as VectorCommand[])).toBeGreaterThan(0)
    }
  })

  it('reads its copies from the RENDERER’s stack resolution, budget included', () => {
    // `vtSolidExtrudeLayers` is the seam, and it must be the same walk the draw
    // loop does — including the spent frame budget. A union of 32 copies over a
    // preview the budget shortened to fewer is a bake that does not match its
    // own preview, and nothing in the picture says so.
    const c = stack({ kind: 'extrude', paint: BLUE, depth: 32, distance: 4, solid: true })
    const few = vtSolidExtrudeLayers(c, 4)
    const many = vtSolidExtrudeLayers(c, 500) // way past VT_EXTRUDE_FRAME_BUDGET
    expect(few[0]?.copies.length).toBe(32)
    expect(many[0]?.copies.length).toBeLessThan(32)
  })

  // ── the box this function owns ────────────────────────────────────────────
  // `fit: 'width'` is solved against a box, and only a caller that HAS one can
  // say so. This function owns the very box it hands to `vtPlacement`, so a
  // frame built without it fits nothing: the union fuses around geometry the
  // preview never drew, and the body cache — keyed on the placed commands —
  // can never hit the drawn glyph's entry.

  /** The extent of a command list, over its on-path points. Enough to say two
   *  bodies are the same body: a run fitted to a different width lands its ink
   *  somewhere else entirely. */
  function extent(commands: readonly VectorCommand[]): { minX: number; maxX: number; minY: number; maxY: number } {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const c of commands) {
      const a = c.args
      for (let i = 0; i + 1 < a.length; i += 2) {
        minX = Math.min(minX, a[i] as number); maxX = Math.max(maxX, a[i] as number)
        minY = Math.min(minY, a[i + 1] as number); maxY = Math.max(maxY, a[i + 1] as number)
      }
    }
    return { minX, maxX, minY, maxY }
  }
  const round = (b: ReturnType<typeof extent>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 100) / 100]))

  /** `prepareSolidExtrudes`' own loop, over a frame THIS test chose — so the
   *  only thing under test is which frame the real one builds. */
  async function bodiesFor(frame: ReturnType<typeof vectorTypeFrame>): Promise<Map<string, VectorCommand[]>> {
    const out = new Map<string, VectorCommand[]>()
    const place = vtPlacement(frame, BOX)
    const placed = placeOutlines(frame.outlines, place)
    for (const layer of vtSolidExtrudeLayers(frame.config, frame.outlines.glyphs.length)) {
      for (let i = 0; i < placed.length; i++) {
        const glyph = frame.outlines.glyphs[i]
        const commands = placed[i]
        if (!glyph || !commands?.length) continue
        const body = await solidExtrudeBody(
          commands, layer.copies, glyphPlacement(glyph, place), glyph.advance * place.scale)
        if (body.length) out.set(vtSolidKey(layer.id, i), body)
      }
    }
    return out
  }

  it('solves fit against the SAME box it places into', async () => {
    const c = cfg({
      fit: 'width',
      appearance: [vtLayer({ id: 'L0', kind: 'extrude', paint: BLUE, depth: 5, distance: 4, angle: 0, solid: true })],
    })
    const fitBoxWidth = Math.max(0, BOX.width - 2 * 0)
    const fitted = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    const blind = vectorTypeFrame(font, c, 0)
    // Teeth: the two frames really are different runs, so an equality below
    // cannot pass by accident.
    expect(Math.abs(fitted.outlines.width - blind.outlines.width)).toBeGreaterThan(1)

    clearSolidExtrudeCache()
    const got = await prepareSolidExtrudes(font, c, 0, BOX)
    const want = await bodiesFor(fitted)
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort())
    for (const [key, body] of want) {
      expect(round(extent(got.get(key) as VectorCommand[])), key).toEqual(round(extent(body)))
    }
  })

  it('skips a layer with NO id rather than colliding every one onto one key', async () => {
    const c = cfg({ appearance: [vtLayer({ id: '', kind: 'extrude', paint: BLUE, depth: 4, solid: true })] })
    // `mergeConfig` mints ids, so force the empty one back on afterwards — the
    // raw-blob case this guard exists for.
    ;(c.appearance[0] as VtAppearanceLayer).id = ''
    expect(vtSolidExtrudeLayers(c, N)).toEqual([])
    expect((await prepareSolidExtrudes(font, c, 0, BOX)).size).toBe(0)
  })
})

// ── the recording context ───────────────────────────────────────────────────
// A deliberately small one: this spec cares about WHAT was filled (the body or
// the glyph), not about paint spaces — `vectortype-extrude.unit.spec.ts` already
// reads back CTMs and path matrices for those.

type Mat = [number, number, number, number, number, number]

class FakeMatrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  static from(m: Mat): FakeMatrix { return new FakeMatrix(...m) }
  get mat(): Mat { return [this.a, this.b, this.c, this.d, this.e, this.f] }
  multiply(o: FakeMatrix): FakeMatrix {
    return new FakeMatrix(
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    )
  }
  translate(x: number, y: number) { return this.multiply(new FakeMatrix(1, 0, 0, 1, x, y)) }
  scale(x: number, y = x) { return this.multiply(new FakeMatrix(x, 0, 0, y, 0, 0)) }
  inverse(): FakeMatrix {
    const det = this.a * this.d - this.b * this.c
    if (!det) return new FakeMatrix(NaN, NaN, NaN, NaN, NaN, NaN)
    return new FakeMatrix(
      this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
    )
  }
}

/** Records the COMMANDS it was built from, so "it filled the body" is a fact
 *  about geometry rather than about a call count. */
class FakePath2D {
  cmds: VectorCommand[] = []
  addPath() {}
  moveTo(x: number, y: number) { this.cmds.push({ command: 'moveTo', args: [x, y] }) }
  lineTo(x: number, y: number) { this.cmds.push({ command: 'lineTo', args: [x, y] }) }
  quadraticCurveTo(...a: number[]) { this.cmds.push({ command: 'quadraticCurveTo', args: a }) }
  bezierCurveTo(...a: number[]) { this.cmds.push({ command: 'bezierCurveTo', args: a }) }
  closePath() { this.cmds.push({ command: 'closePath', args: [] }) }
}

interface Rec {
  op: 'fill' | 'stroke'
  alpha: number
  gco: string
  /** The CTM the paint happened under — for a motionless config this IS the
   *  copy's own transform, which is how the canvas is compared to the union. */
  m: Mat
  cmds: VectorCommand[] | null
}

class RecCtx {
  paints: Rec[] = []
  private stack: Array<{ alpha: number; gco: string; filter: string; m: Mat }> = []
  private m: Mat = [1, 0, 0, 1, 0, 0]
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  filter = 'none'
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 0
  lineJoin = ''
  getTransform(): FakeMatrix { return FakeMatrix.from(this.m) }
  setTransform(...a: unknown[]) {
    if (a.length === 1 && a[0] instanceof FakeMatrix) this.m = (a[0] as FakeMatrix).mat
    else this.m = (a as number[]).slice(0, 6) as Mat
  }
  save() { this.stack.push({ alpha: this.globalAlpha, gco: this.globalCompositeOperation, filter: this.filter, m: [...this.m] as Mat }) }
  restore() {
    const s = this.stack.pop()
    if (s) { this.globalAlpha = s.alpha; this.globalCompositeOperation = s.gco; this.filter = s.filter; this.m = s.m }
  }
  translate(x: number, y: number) { this.m = FakeMatrix.from(this.m).translate(x, y).mat }
  rotate(r: number) { this.m = FakeMatrix.from(this.m).multiply(new FakeMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)).mat }
  scale(x: number, y: number) { this.m = FakeMatrix.from(this.m).scale(x, y).mat }
  clearRect() {}
  fillRect() {}
  beginPath() {}
  rect() {}
  clip() {}
  createLinearGradient() { return { addColorStop() {} } }
  createRadialGradient() { return { addColorStop() {} } }
  createPattern() { return null }
  private record(op: 'fill' | 'stroke', path?: unknown) {
    this.paints.push({
      op, alpha: this.globalAlpha, gco: this.globalCompositeOperation,
      m: [...this.m] as Mat,
      cmds: path instanceof FakePath2D ? path.cmds : null,
    })
  }
  fill(path?: unknown) { this.record('fill', path) }
  stroke(path?: unknown) { this.record('stroke', path) }
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

function draw(c: VectorTypeConfig, t = 0, opts: Record<string, unknown> = {}) {
  const ctx = new RecCtx()
  const frame = drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, { ...BOX, ...opts })
  return { ctx, frame }
}
