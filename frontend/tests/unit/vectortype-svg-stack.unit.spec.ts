/**
 * Vector Type — the APPEARANCE STACK, exported as SVG.
 *
 * Until this task the exporter collapsed the stack to one fill plus one stroke
 * (`vtBaseAppearance`), so a three-layer design exported as one layer and an
 * extrude exported as nothing at all. Now every enabled layer emits its own
 * shapes and an extrude emits `depth` of them per glyph — or exactly ONE, when a
 * caller has awaited the boolean union.
 *
 * Five claims, ordered by how easy each would be to fake:
 *
 *  1. **K shapes per glyph, and the right K.** Counted off the emitted document
 *     with a regex, per layer kind, against the copy count the canvas resolves.
 *  2. **The order is LAYER-MAJOR.** Not "the shapes are all there" — the ORDER,
 *     asserted as the sequence of `d` attributes, because SVG paints in document
 *     order and an extrude has REACH. Task 4 measured 42 % of a letter's face
 *     eaten when this loop nested the other way; the test that catches it is one
 *     that reads the order, not one that counts.
 *  3. **The `<defs>` are per distinct PAINT, not per shape.** A six-letter word
 *     with a three-layer stack sharing one ramp emits ONE `<linearGradient>`,
 *     not 18. Counted on the real document.
 *  4. **A stroke layer paints no fill**, so a stroke UNDER a fill is a stack
 *     expression rather than a letter covered by its own outline.
 *  5. **A solid extrude is one `<path>` per glyph**, and falls back to the
 *     copies — the picture the live preview shows — when no body was handed in.
 *
 * Plus the two seams this task added: `outlinesToShapes`'s `expand` contract,
 * and the union's frame cache, which is what makes a VIDEO bake of a solid
 * extrude affordable (~1.3 ms per copy, otherwise paid on every frame).
 *
 * NO NETWORK, NO DOM: the same eight-character Inter variable subset every other
 * Vector Type spec uses. paper.js runs headless for the cache tests.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VectorCommand } from '~/lib/vector/svg'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
} from '~/lib/vectortype/config'
import { extrudeCopyCommands, extrudeCopyTransform, vtSolidKey } from '~/lib/vectortype/extrude'
import * as extrudeBodyCache from '~/lib/vectortype/extrudeBodyCache'
import {
  clearSolidExtrudeCache,
  prepareSolidExtrudes,
  solidExtrudeBodyCached,
  solidExtrudeCacheSize,
} from '~/lib/vectortype/extrudeSolid'
import { vectorTypeSVG, vectorTypeFrame, vtPlacement } from '~/lib/vectortype/canvas'
import { glyphTransform as glyphPlacement, outlinesToShapes, placeOutlines } from '~/lib/vectortype/render'
import { textOutlines } from '~/lib/vectortype/outline'

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

/** Every `<path>` element of a document, in document order — which IS paint
 *  order, which is the whole point of most of what follows. */
const paths = (svg: string): string[] => [...svg.matchAll(/<path\b[^>]*\/>/g)].map(m => m[0] as string)
const dOf = (tag: string): string => /\sd="([^"]*)"/.exec(tag)?.[1] ?? ''
const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null
const count = (svg: string, re: RegExp): number => (svg.match(re) ?? []).length

/** The glyph outlines this config places, in the export's own output space —
 *  used to build the copies a test EXPECTS, from the same two functions the
 *  exporter itself uses. */
function placedFor(c: VectorTypeConfig) {
  const frame = vectorTypeFrame(font, c, 0)
  const place = vtPlacement(frame, BOX)
  return {
    frame,
    place,
    placed: placeOutlines(frame.outlines, place),
    origin: (i: number) => glyphPlacement(frame.outlines.glyphs[i]!, place),
    advance: (i: number) => frame.outlines.glyphs[i]!.advance * place.scale,
  }
}

const linear = (a: string, b: string) => ({
  type: 'gradient' as const, a, b, textColor: a, angle: 45, density: 8,
})

// ── 1. K shapes per glyph ───────────────────────────────────────────────────

describe('the export emits K shapes per glyph — one per layer, `depth` per extrude', () => {
  it('emits ONE path per glyph per fill/stroke layer, not one for the whole stack', () => {
    const one = vectorTypeSVG(font, stack({ kind: 'fill', paint: RED }), 0, BOX)
    expect(paths(one.svg)).toHaveLength(N)

    const three = vectorTypeSVG(font, stack(
      { kind: 'stroke', width: 8, paint: BLUE },
      { kind: 'fill', paint: RED },
      { kind: 'stroke', width: 2, paint: '#00ff00' },
    ), 0, BOX)
    // The pre-task-6 collapse would have emitted N — one fill + one stroke on
    // one path per glyph — and thrown the third layer away entirely.
    expect(paths(three.svg)).toHaveLength(N * 3)
  })

  it('emits `depth` paths per glyph for an EXTRUDE, plus one for the face', () => {
    for (const depth of [1, 4, 8, 16]) {
      const c = stack(
        { kind: 'extrude', depth, distance: 5, angle: 0, paint: BLUE },
        { kind: 'fill', paint: RED },
      )
      expect(paths(vectorTypeSVG(font, c, 0, BOX).svg), `depth ${depth}`)
        .toHaveLength(N * depth + N)
    }
  })

  it('emits NOTHING for a layer the renderer drops — depth 0, width 0, disabled', () => {
    const base = N
    for (const layer of [
      { kind: 'extrude' as const, depth: 0, paint: BLUE },
      { kind: 'stroke' as const, width: 0, paint: BLUE },
      { kind: 'fill' as const, paint: RED, enabled: false },
      { kind: 'fill' as const, paint: RED, opacity: 0 },
    ]) {
      const c = stack(layer, { kind: 'fill', paint: RED })
      expect(paths(vectorTypeSVG(font, c, 0, BOX).svg), JSON.stringify(layer)).toHaveLength(base)
    }
  })

  it('emits an EMPTY document for an empty stack, rather than a white default', () => {
    // `appearance: []` is the user having removed every layer — the canvas paints
    // nothing, and the file must agree. The old collapse fell back to '#ffffff'
    // and exported a white word onto a transparent page.
    const { svg } = vectorTypeSVG(font, cfg({ appearance: [] }), 0, BOX)
    expect(paths(svg)).toHaveLength(0)
  })

  it('steps each extrude copy with `extrudeCopyTransform` — the canvas’s own arithmetic', () => {
    const depth = 3, distance = 7, angle = 0
    const c = stack({ kind: 'extrude', depth, distance, angle, paint: BLUE })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const { placed, origin, advance } = placedFor(c)

    // Built from `extrudeCopyCommands` — the same function the union unites —
    // and compared as the `d` STRING, so a step that was half a pixel off would
    // fail. Glyph 0's three copies are the document's first three paths.
    const expected = extrudeCopyCommands(placed[0]!, [
      { dx: 0, dy: 0, scale: 1 },
    ], origin(0), advance(0))
    expect(expected).toHaveLength(1)

    const emitted = paths(svg).slice(0, depth).map(dOf)
    expect(new Set(emitted).size).toBe(depth)
    // The copies are BACK TO FRONT: copy 0 is the farthest, so at angle 0 its x
    // is the largest. Read the first moveTo of each.
    const firstX = emitted.map(d => Number.parseFloat(/^M(-?[\d.]+)/.exec(d)![1] as string))
    expect(firstX[0]).toBeGreaterThan(firstX[1] as number)
    expect(firstX[1]).toBeGreaterThan(firstX[2] as number)
    // …and consecutive copies are exactly `distance` apart.
    expect((firstX[0] as number) - (firstX[1] as number)).toBeCloseTo(distance, 3)
    // The near copy sits at 1 × distance from the glyph, never at 0: the face is
    // a separate layer.
    const bare = /^M(-?[\d.]+)/.exec(
      // the un-copied glyph, through the same writer
      dOf(paths(vectorTypeSVG(font, stack({ kind: 'fill', paint: RED }), 0, BOX).svg)[0] as string),
    )![1] as string
    expect((firstX[depth - 1] as number) - Number.parseFloat(bare)).toBeCloseTo(distance, 3)
    // And the transform the exporter used is the one `extrudeCopyTransform` gives.
    expect(extrudeCopyTransform({ dx: distance, dy: 0, scale: 1 }, origin(0), advance(0)))
      .toEqual({ scale: 1, rotate: 0, x: distance, y: 0, flipY: false })
  })
})

// ── 2. LAYER-MAJOR order ────────────────────────────────────────────────────

describe('the shape order is LAYER-MAJOR — a layer covers the whole run first', () => {
  const c = stack(
    { kind: 'extrude', depth: 2, distance: 6, angle: 180, paint: BLUE },
    { kind: 'fill', paint: RED },
  )

  it('emits every glyph of the extrude BEFORE any of the face', () => {
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const fills = paths(svg).map(t => attr(t, 'fill'))
    expect(fills).toHaveLength(N * 2 + N)
    // The first 2N are the extrude, the last N are the face. Glyph-major would
    // interleave them — blue, blue, red, blue, blue, red …
    expect(fills.slice(0, N * 2).every(f => f === BLUE)).toBe(true)
    expect(fills.slice(N * 2).every(f => f === RED)).toBe(true)
  })

  it('is the order that keeps letter 1’s face out from under letter 2’s shadow', () => {
    // The concrete failure, as geometry rather than as a colour sequence: at
    // angle 180 the extrude steps LEFT, so glyph 1's copies overlap glyph 0's
    // face. Every face path must come after every copy path in document order.
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const tags = paths(svg)
    const lastCopy = tags.map(t => attr(t, 'fill')).lastIndexOf(BLUE)
    const firstFace = tags.map(t => attr(t, 'fill')).indexOf(RED)
    expect(firstFace).toBeGreaterThan(lastCopy)
  })

  it('orders the copies of ONE glyph back to front, inside the layer', () => {
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const xs = paths(svg).slice(0, 2).map(t =>
      Number.parseFloat(/^M(-?[\d.]+)/.exec(dOf(t))![1] as string))
    // angle 180 → dx negative → the FARTHEST copy has the smallest x, and it is
    // emitted first so the nearer one lands on top of it.
    expect(xs[0]).toBeLessThan(xs[1] as number)
  })

  it('follows the STACK’s own order, not a fixed fill-then-stroke pair', () => {
    const below = stack({ kind: 'stroke', width: 10, paint: BLUE }, { kind: 'fill', paint: RED })
    const above = stack({ kind: 'fill', paint: RED }, { kind: 'stroke', width: 10, paint: BLUE })
    const kindOf = (c2: VectorTypeConfig) =>
      paths(vectorTypeSVG(font, c2, 0, BOX).svg).map(t => (attr(t, 'stroke') ? 'stroke' : 'fill'))
    expect(kindOf(below)).toEqual([...Array(N).fill('stroke'), ...Array(N).fill('fill')])
    expect(kindOf(above)).toEqual([...Array(N).fill('fill'), ...Array(N).fill('stroke')])
  })
})

// ── 3. `<defs>` dedupe ──────────────────────────────────────────────────────

describe('the <defs> hold one entry per distinct PAINT, not per shape', () => {
  it('shares ONE gradient across three layers and every glyph', () => {
    const ramp = linear('#ff0000', '#0000ff')
    const c = cfg({
      text: 'Sailor',
      appearance: [
        vtLayer({ id: 'L0', kind: 'extrude', depth: 4, distance: 4, paint: ramp, anchor: 'word' }),
        vtLayer({ id: 'L1', kind: 'fill', paint: ramp, anchor: 'word' }),
        vtLayer({ id: 'L2', kind: 'fill', paint: ramp, anchor: 'word', opacity: 0.5 }),
      ],
    })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    // 6 letters × (4 copies + 1 + 1) = 36 shapes…
    expect(paths(svg)).toHaveLength(36)
    // …and ONE paint server between them. 36 would be one per shape; 18 would be
    // the "6 letters × 3 layers" the brief names as the failure to rule out.
    expect(count(svg, /<linearGradient\b/g)).toBe(1)
    const ids = new Set(paths(svg).map(t => attr(t, 'fill')))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/^url\(#/)
  })

  it('emits one per DISTINCT ramp, so the dedupe is not just “always one”', () => {
    const c = cfg({
      text: 'Sailor',
      appearance: [
        vtLayer({ id: 'L0', kind: 'fill', paint: linear('#ff0000', '#0000ff'), anchor: 'word' }),
        vtLayer({ id: 'L1', kind: 'fill', paint: linear('#00ff00', '#0000ff'), anchor: 'word' }),
      ],
    })
    expect(count(vectorTypeSVG(font, c, 0, BOX).svg, /<linearGradient\b/g)).toBe(2)
  })

  it('shares one glyph-anchored ramp across every letter — the bounding-box form', () => {
    // At the `glyph` anchor each letter carries its own copy of the ramp via
    // `objectBoundingBox`, and an AXIS-ALIGNED ramp needs no per-letter aspect
    // correction, so the markup is identical and one definition serves all six.
    const c = cfg({
      text: 'Sailor',
      appearance: [vtLayer({ id: 'L0', kind: 'fill', paint: { ...linear('#ff0000', '#0000ff'), angle: 0 } })],
    })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    expect(paths(svg)).toHaveLength(6)
    expect(count(svg, /<linearGradient\b/g)).toBe(1)
  })

  it('shares one clip and one filter across the layers of a motion frame', () => {
    // A blur or a mask is per GLYPH, not per layer, so a three-layer stack must
    // not triple the `<defs>` — the key is the value, and the values are equal.
    const c = cfg({
      text: 'Sail',
      appearance: [
        vtLayer({ id: 'L0', kind: 'fill', paint: RED }),
        vtLayer({ id: 'L1', kind: 'stroke', width: 4, paint: BLUE }),
        vtLayer({ id: 'L2', kind: 'fill', paint: '#00ff00', opacity: 0.4 }),
      ],
      motion: {
        ...DEFAULT_CONFIG.motion,
        moves: [{
          id: 'move-in', phase: 'in', kind: 'preset', presetId: 'blur-in', duration: 1,
          ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
        }],
      },
    })
    const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
    expect(paths(svg)).toHaveLength(12)
    const filters = count(svg, /<filter\b/g)
    expect(filters).toBeGreaterThan(0)
    // One per distinct blur radius. Every glyph shares one radius here (no
    // stagger), so one filter — never 12.
    expect(filters).toBe(1)
  })
})

// ── 4. a stroke layer paints no fill ────────────────────────────────────────

describe('a STROKE layer paints no fill', () => {
  it('writes fill="none" so the layer below shows through', () => {
    const c = stack({ kind: 'fill', paint: RED }, { kind: 'stroke', width: 8, paint: BLUE })
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const tags = paths(svg)
    expect(tags.slice(0, N).every(t => attr(t, 'fill') === RED)).toBe(true)
    expect(tags.slice(N).every(t => attr(t, 'fill') === 'none')).toBe(true)
    expect(tags.slice(N).every(t => attr(t, 'stroke') === BLUE)).toBe(true)
    expect(tags.slice(N).every(t => attr(t, 'stroke-width') === '8')).toBe(true)
  })

  it('carries the layer’s OWN width, so two strokes are two widths', () => {
    const c = stack(
      { kind: 'stroke', width: 12, paint: BLUE },
      { kind: 'fill', paint: RED },
      { kind: 'stroke', width: 3, paint: '#00ff00' },
    )
    const widths = paths(vectorTypeSVG(font, c, 0, BOX).svg).map(t => attr(t, 'stroke-width'))
    expect(widths.slice(0, N).every(w => w === '12')).toBe(true)
    expect(widths.slice(N, N * 2).every(w => w === null)).toBe(true)
    expect(widths.slice(N * 2).every(w => w === '3')).toBe(true)
  })
})

// ── 5. layer opacity and blend ──────────────────────────────────────────────

describe('a layer’s opacity MULTIPLIES the glyph’s, and its blend survives', () => {
  it('writes the product, not either factor', () => {
    const c = cfg({
      text: 'Sail',
      appearance: [vtLayer({ id: 'L0', kind: 'fill', paint: RED, opacity: 0.5 })],
      motion: {
        ...DEFAULT_CONFIG.motion,
        moves: [{
          id: 'move-in', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 1,
          ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
        }],
      },
    })
    const solidOpacity = paths(vectorTypeSVG(font, stack({ kind: 'fill', paint: RED, opacity: 0.5 }), 0, BOX).svg)
      .map(t => attr(t, 'opacity'))
    expect(solidOpacity.every(o => o === '0.5')).toBe(true)

    const mid = paths(vectorTypeSVG(font, c, 0.5, BOX).svg).map(t => Number(attr(t, 'opacity')))
    const glyphAlpha = vectorTypeFrame(font, c, 0.5).transforms[0]!.opacity
    expect(glyphAlpha).toBeGreaterThan(0)
    expect(glyphAlpha).toBeLessThan(1)
    expect(mid[0]).toBeCloseTo(glyphAlpha * 0.5, 3)
  })

  it('omits the attribute entirely at full opacity', () => {
    const { svg } = vectorTypeSVG(font, stack({ kind: 'fill', paint: RED }), 0, BOX)
    expect(svg).not.toContain('opacity=')
  })

  it('writes mix-blend-mode for a non-normal layer, and nothing for normal', () => {
    const plain = vectorTypeSVG(font, stack({ kind: 'fill', paint: RED }), 0, BOX)
    expect(plain.svg).not.toContain('mix-blend-mode')
    const mult = vectorTypeSVG(font, stack(
      { kind: 'fill', paint: RED },
      { kind: 'fill', paint: BLUE, blend: 'multiply' },
    ), 0, BOX)
    expect(count(mult.svg, /mix-blend-mode:multiply/g)).toBe(N)
  })
})

// ── 6. the SOLID extrude ────────────────────────────────────────────────────

describe('a SOLID extrude exports as ONE <path> per glyph', () => {
  const depth = 6
  const c = stack(
    { kind: 'extrude', depth, distance: 5, angle: 45, solid: true, paint: BLUE },
    { kind: 'fill', paint: RED },
  )

  it('emits `depth` copies with no bodies — the picture the preview shows', () => {
    expect(paths(vectorTypeSVG(font, c, 0, BOX).svg)).toHaveLength(N * depth + N)
  })

  it('emits ONE with the bodies, and it is the BODY’s geometry', async () => {
    const solid = await prepareSolidExtrudes(font, c, 0, BOX)
    expect(solid.size).toBe(N)
    const { svg } = vectorTypeSVG(font, c, 0, { ...BOX, solid })
    const tags = paths(svg)
    expect(tags).toHaveLength(N + N)
    // The first N are the extrude layer — one per glyph, each a real body and
    // not a stub: a fused block shadow is a long path.
    for (let i = 0; i < N; i++) {
      expect(attr(tags[i] as string, 'fill')).toBe(BLUE)
      expect(dOf(tags[i] as string).length).toBeGreaterThan(200)
    }
    expect(tags.slice(N).every(t => attr(t, 'fill') === RED)).toBe(true)
  })

  it('falls back to the copies for a layer the map has no body for', async () => {
    const solid = await prepareSolidExtrudes(font, c, 0, BOX)
    const partial = new Map(solid)
    partial.delete(vtSolidKey('L0', 1))
    const { svg } = vectorTypeSVG(font, c, 0, { ...BOX, solid: partial })
    // 3 glyphs fused (1 path each) + 1 glyph on its 6 copies + N faces.
    expect(paths(svg)).toHaveLength((N - 1) + depth + N)
  })

  it('leaves a NON-solid extrude on its copies even when a body exists', async () => {
    const notSolid = stack(
      { kind: 'extrude', depth, distance: 5, angle: 45, solid: false, paint: BLUE },
      { kind: 'fill', paint: RED },
    )
    // A body keyed for L0 from the solid config — the flag, not the map, decides.
    const solid = await prepareSolidExtrudes(font, c, 0, BOX)
    const { svg } = vectorTypeSVG(font, notSolid, 0, { ...BOX, solid })
    expect(paths(svg)).toHaveLength(N * depth + N)
  })

  it('addresses the body by the layer’s stable ID, not its stack position', async () => {
    const solid = await prepareSolidExtrudes(font, c, 0, BOX)
    // The same two layers, reordered: the extrude is now index 1.
    const swapped = cfg({
      appearance: [
        vtLayer({ id: 'L1', kind: 'fill', paint: RED }),
        vtLayer({ id: 'L0', kind: 'extrude', depth, distance: 5, angle: 45, solid: true, paint: BLUE }),
      ],
    })
    const tags = paths(vectorTypeSVG(font, swapped, 0, { ...BOX, solid }).svg)
    // Still found — N faces first, then N fused bodies.
    expect(tags).toHaveLength(N + N)
    expect(tags.slice(0, N).every(t => attr(t, 'fill') === RED)).toBe(true)
    expect(tags.slice(N).every(t => attr(t, 'fill') === BLUE)).toBe(true)
  })
})

// ── 7. `outlinesToShapes`'s expand contract ─────────────────────────────────

describe('outlinesToShapes — the `expand` seam', () => {
  const outlines = () => textOutlines(font, 'ab')

  it('emits one shape per glyph with no expansion — unchanged behaviour', () => {
    expect(outlinesToShapes(outlines(), { fill: RED })).toHaveLength(2)
  })

  it('flatMaps K shapes per glyph, all sharing the glyph’s resolved paint', () => {
    const shapes = outlinesToShapes(outlines(), {
      fill: (_g, i) => (i === 0 ? RED : BLUE),
      expand: cmds => [cmds, cmds, cmds],
    })
    expect(shapes).toHaveLength(6)
    expect(shapes.map(s => s.fill)).toEqual([RED, RED, RED, BLUE, BLUE, BLUE])
  })

  it('treats an EMPTY array as “no shapes”, not as “no expansion”', () => {
    const shapes = outlinesToShapes(outlines(), { fill: RED, expand: (_c, _g, i) => (i === 0 ? [] : null) })
    expect(shapes).toHaveLength(1)
  })

  it('keeps a null fill as the spine’s explicit `fill="none"`', () => {
    // `undefined` still means "nobody said" and keeps the black default; `null`
    // is a stroke-only layer SAYING no fill, and collapsing it to black would
    // paint the letter solid under its own outline.
    expect(outlinesToShapes(outlines(), {})[0]!.fill).toBe('#000000')
    expect(outlinesToShapes(outlines(), { fill: null })[0]!.fill).toBeNull()
  })
})

// ── 8. the union's frame cache — what makes a VIDEO bake affordable ─────────

describe('the solid-extrude union caches on its INPUTS', () => {
  beforeEach(() => clearSolidExtrudeCache())

  const c = stack({ kind: 'extrude', depth: 4, distance: 5, angle: 45, solid: true, paint: BLUE })

  it('returns the identical body on a hit — the cache cannot change the picture', async () => {
    const { placed, origin, advance } = placedFor(c)
    const copies = [{ dx: 4, dy: 4, scale: 1 }, { dx: 8, dy: 8, scale: 1 }]
    const cold = await solidExtrudeBodyCached(placed[0]!, copies, origin(0), advance(0))
    expect(solidExtrudeCacheSize()).toBe(1)
    const warm = await solidExtrudeBodyCached(placed[0]!, copies, origin(0), advance(0))
    expect(warm).toBe(cold)
    expect(warm.length).toBeGreaterThan(4)
  })

  it('MISSES when any of the four inputs moves — geometry, copies, origin, advance', async () => {
    const { placed, origin, advance } = placedFor(c)
    const copies = [{ dx: 4, dy: 4, scale: 1 }]
    await solidExtrudeBodyCached(placed[0]!, copies, origin(0), advance(0))
    expect(solidExtrudeCacheSize()).toBe(1)
    // a different glyph's outline
    await solidExtrudeBodyCached(placed[1]!, copies, origin(0), advance(0))
    // a different copy list (an animated `distance`)
    await solidExtrudeBodyCached(placed[0]!, [{ dx: 5, dy: 4, scale: 1 }], origin(0), advance(0))
    // a different origin (an animated translate)
    await solidExtrudeBodyCached(placed[0]!, copies, { x: origin(0).x + 1, y: origin(0).y }, advance(0))
    // a different advance (an animated tracking)
    await solidExtrudeBodyCached(placed[0]!, copies, origin(0), advance(0) + 1)
    expect(solidExtrudeCacheSize()).toBe(5)
  })

  it('MISSES on the same glyph at a different AXIS — same command count, moved points', async () => {
    // The dangerous case, and the one a lazier key would get wrong: an axis
    // track re-shapes the SAME letter, so the command COUNT is unchanged and only
    // the coordinates move. A key that summarised the geometry (its length, its
    // first point, a rounded hash) would HIT and hand frame 30 frame 0's body —
    // a plausible solid extrude that is not the one on screen.
    //
    // Found by breaking it: with the key reading `commands.length` instead of the
    // commands, the four assertions above all still passed, because they vary the
    // glyph and two different letters have different command counts.
    const light = placedFor(cfg({ ...c, axes: { wght: 100 } }))
    const heavy = placedFor(cfg({ ...c, axes: { wght: 900 } }))
    expect(light.placed[0]!).toHaveLength(heavy.placed[0]!.length)
    expect(light.placed[0]!).not.toEqual(heavy.placed[0]!)

    const copies = [{ dx: 4, dy: 4, scale: 1 }]
    const a = await solidExtrudeBodyCached(light.placed[0]!, copies, { x: 0, y: 0 }, 50)
    const b = await solidExtrudeBodyCached(heavy.placed[0]!, copies, { x: 0, y: 0 }, 50)
    expect(solidExtrudeCacheSize()).toBe(2)
    expect(a).not.toEqual(b)
  })

  it('makes a REPEATED frame free — a static extrude over a video bake', async () => {
    // The whole point: a sequence bake re-asks for the same bodies every frame,
    // and extrude geometry is time-invariant unless something feeding it moves.
    //
    // This used to pin that with a wall-clock bound (`warmMs <=
    // Math.max(coldMs, 2)`), which reddened on a loaded machine: paper.js's
    // union is fast enough here that `coldMs` itself can be 0-1 ms, so the bound
    // was sub-2-ms and any scheduling jitter on the warm loop's nine awaits blew
    // through it despite zero actual recomputation. Timing was never the claim —
    // "the union did not run again" is — so pin THAT directly: `putSolidBody` is
    // the store's only write, and `solidExtrudeBodyCached` calls it exactly once
    // per cache MISS (see extrudeSolid.ts), so its call count is a deterministic,
    // clock-free proxy for "how many unions actually ran". It is imported from
    // `extrudeBodyCache.ts` — a different module than the one under test — so
    // `vi.spyOn` intercepts the real cross-module call rather than a same-module
    // reference a spy cannot see.
    const putSpy = vi.spyOn(extrudeBodyCache, 'putSolidBody')
    try {
      await prepareSolidExtrudes(font, c, 0, BOX)
      expect(solidExtrudeCacheSize()).toBe(N)
      const coldCalls = putSpy.mock.calls.length
      expect(coldCalls).toBe(N)

      for (let f = 1; f < 10; f++) await prepareSolidExtrudes(font, c, f / 30, BOX)
      // Nine more frames, no new entries: every one of them hit.
      expect(solidExtrudeCacheSize()).toBe(N)
      // And, unlike the cache-size check above, this cannot be fooled by a
      // recompute that happens to reproduce the same body and overwrite the same
      // key: no NEW writes happened at all across the nine warm frames.
      expect(putSpy.mock.calls.length).toBe(coldCalls)
    } finally {
      putSpy.mockRestore()
    }
  })

  it('never caches a FAILED union, so one bad frame is not permanent', async () => {
    // A union of nothing is the reachable empty answer; a real failure returns
    // `[]` the same way (see `unionCommandLists`'s catch).
    const empty = await solidExtrudeBodyCached([], [{ dx: 1, dy: 1, scale: 1 }], { x: 0, y: 0 }, 10)
    expect(empty).toEqual([])
    expect(solidExtrudeCacheSize()).toBe(0)
  })
})

// ── 9. the extrude copy list has ONE derivation ─────────────────────────────

describe('extrudeCopyCommands — the one derivation the export and the union share', () => {
  it('is exactly `extrudeCopyTransform` per copy, in order', () => {
    const commands: VectorCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'lineTo', args: [10, 0] },
      { command: 'closePath', args: [] },
    ]
    const copies = [{ dx: 9, dy: 3, scale: 1 }, { dx: 3, dy: 1, scale: 0.5 }]
    const out = extrudeCopyCommands(commands, copies, { x: 100, y: 50 }, 20)
    expect(out).toHaveLength(2)
    expect(out[0]![0]!.args).toEqual([9, 3])
    // The tapered copy scales about the CELL CENTRE (100 + 20/2 = 110) and the
    // BASELINE (50) — the fold `extrudeCopyTransform` documents.
    const t = extrudeCopyTransform(copies[1]!, { x: 100, y: 50 }, 20)
    expect(out[1]![0]!.args).toEqual([t.x, t.y])
    expect(out[1]![1]!.args).toEqual([t.x + 10 * 0.5, t.y])
  })

  it('never flips y — the flip is already baked into the placed coordinates', () => {
    const commands: VectorCommand[] = [{ command: 'moveTo', args: [0, 40] }]
    const out = extrudeCopyCommands(commands, [{ dx: 0, dy: 0, scale: 1 }], { x: 0, y: 0 }, 10)
    expect(out[0]![0]!.args).toEqual([0, 40])
  })
})
