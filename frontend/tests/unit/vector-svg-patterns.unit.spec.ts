/**
 * The vector spine's `<defs>` — procedural `<pattern>` paint servers.
 *
 * Same two halves as the gradient spec: the spine half says nothing about type,
 * the adapter half checks that what the canvas renderer paints is what the
 * export writes.
 *
 * The failure modes this is aimed at, none of which a picture can see:
 *
 *  - **A mirrored renderer.** Four fills whose cell geometry is now stated in
 *    TWO places — the canvas tile builder and the `<pattern>` emitter. Drift
 *    here is invisible: both surfaces still show a checkerboard. So the cell
 *    edge, the line width and the three "is this cell `b`?" predicates are one
 *    definition each, and these tests assert the emitter uses THEM rather than
 *    numbers that happen to agree today.
 *  - **A lattice in the wrong place.** A pattern's phase is part of the picture;
 *    half a cell of offset is a different design. The placement rides entirely
 *    in `patternTransform`, so the tests check that matrix, not just the tile.
 *  - **A pattern that travels with the letter.** Same fact as the gradient's
 *    `userSpaceOnUse` — measured in task 4, and it applies here identically.
 *  - **Splitting a line across the tile seam.** Two abutting half-width rects on
 *    opposite edges of a fractional tile do NOT rasterise back into one line in
 *    Chrome; the whole word came out ~10/255 too light. Pinned below.
 *  - **A rounded cell.** `fillTileBox` used to round its cell to whole TILE
 *    pixels, which made the geometry depend on the raster resolution it was
 *    built at and put a resolution-independent export permanently out of step.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import {
  type Affine,
  type VectorPattern,
  type VectorShape,
  defsIdPrefix,
  isVectorPattern,
  multiplyAffine,
  shapesToSVG,
} from '~/lib/vector/svg'
import { paintIsVector, paintToVectorPaint } from '~/lib/paint/toVector'
import {
  DEFAULT_FILL,
  type Fill,
  type FillType,
  checkerCellIsB,
  fillPatternCell,
  gridLineWidth,
  qrCellIsB,
  stripeBandIsB,
} from '~/lib/spacetype/fillTile'
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
const DOC = { width: 200, height: 100, viewBox: [0, 0, 200, 100] as [number, number, number, number] }

const UNIT_BOX = { x: 0, y: 0, width: 240, height: 120 }

function fill(type: FillType, patch: Partial<Fill> = {}): Fill {
  return { ...DEFAULT_FILL, type, a: '#ffe600', b: '#111111', angle: 35, density: 8, ...patch }
}

function pattern(type: FillType, patch: Partial<Fill> = {}, box = UNIT_BOX): VectorPattern {
  const p = paintToVectorPaint(fill(type, patch), { units: 'userSpaceOnUse', box })
  if (!isVectorPattern(p)) throw new Error(`${type} did not emit a pattern`)
  return p
}

function square(x: number, size = 10): VectorShape['commands'] {
  return [
    { command: 'moveTo', args: [x, 10] },
    { command: 'lineTo', args: [x + size, 10] },
    { command: 'lineTo', args: [x + size, 10 + size] },
    { command: 'lineTo', args: [x, 10 + size] },
    { command: 'closePath', args: [] },
  ]
}


/** ═══ APPEARANCE STACK ═══ the `fill` / `fillAnchor` a caller asks for is now
 *  the BASE FILL LAYER's paint and anchor. Translated here so every call site
 *  below reads as it did — the stack is what changed, not what these tests
 *  assert about the document. */
function vtStack(fill: unknown, fillAnchor: unknown) {
  return [vtLayer({ id: 'Lfill', paint: fill as any, anchor: (fillAnchor ?? 'glyph') as any })]
}

function cfg(patch: Partial<VectorTypeConfig> & Record<string, unknown> = {}): VectorTypeConfig {
  const { fill: paint, fillAnchor, ...rest } = patch as Record<string, unknown>
  return mergeConfig({
    ...DEFAULT_CONFIG, text: WORD, size: 100,
    appearance: vtStack(paint ?? fill('checkerboard'), fillAnchor), ...rest,
  })
}

// ── the shared cell maths ───────────────────────────────────────────────────

describe('the cell maths both renderers use', () => {
  it('does NOT round — the cell is a fraction of the box, not a whole pixel', () => {
    // The regression this pins: `Math.max(2, Math.round(W / d))` returned 13
    // here, which is 8 cells of 13 across a 100-wide box, i.e. 104. The density
    // control promises `d` cells that FIT.
    expect(fillPatternCell(100, 8)).toBe(12.5)
    expect(fillPatternCell(800, 7)).toBeCloseTo(800 / 7, 10)
    for (const d of [2, 3, 5, 7, 8, 16, 32]) {
      expect(fillPatternCell(1000, d) * d).toBeCloseTo(1000, 6)
    }
  })

  it('is SQUARE — the same edge on both axes, so nothing stretches', () => {
    // The cell is a function of the WIDTH alone, so a tall box and a wide box
    // of the same width get the same cell and the emitted tiles come out
    // square. A height-aware cell is exactly the drift this asserts against.
    for (const height of [40, 120, 900]) {
      const p = paintToVectorPaint(fill('checkerboard'), {
        units: 'userSpaceOnUse', box: { x: 0, y: 0, width: 240, height },
      }) as VectorPattern
      expect(p.width).toBe(p.height)
      expect(p.width).toBe(fillPatternCell(240, 8) * 2)
    }
  })

  it('floors at 2 units and survives junk density', () => {
    expect(fillPatternCell(4, 32)).toBe(2)
    expect(fillPatternCell(100, 0)).toBe(100)          // density clamps up to 1
    expect(fillPatternCell(100, Number.NaN)).toBe(100)
    expect(fillPatternCell(Number.NaN, 8)).toBe(2)
    expect(fillPatternCell(-50, 8)).toBe(2)
  })

  it('reproduces the canvas pickers, re-derived independently here', () => {
    for (let cx = 0; cx < 12; cx++) {
      for (let cy = 0; cy < 12; cy++) {
        expect(checkerCellIsB(cx, cy)).toBe((cx + cy) % 2 === 1)
        const v = Math.sin(cx * 12.9898 + cy * 78.233 + cx * cy * 3.71) * 43758.5453
        expect(qrCellIsB(cx, cy)).toBe((v - Math.floor(v)) > 0.45)
      }
    }
    for (let k = 0; k < 12; k++) expect(stripeBandIsB(k)).toBe(k % 2 !== 0)
  })

  it('classifies a NEGATIVE stripe band the way SVG tiles it', () => {
    // The canvas only ever samples pixels inside the box, so it never asks.
    // An SVG pattern tiles in both directions, and `-1 % 2` is `-1` in JS —
    // an `=== 1` test would have made every band left of the origin colour `a`.
    for (let k = 1; k < 12; k++) expect(stripeBandIsB(-k)).toBe(stripeBandIsB(k))
    expect(stripeBandIsB(-1)).toBe(true)
    expect(stripeBandIsB(-2)).toBe(false)
    expect(stripeBandIsB(-3)).toBe(true)
  })

  it('rules a grid at 8 % of the cell, with a one-unit hairline floor', () => {
    expect(gridLineWidth(100)).toBe(8)
    expect(gridLineWidth(12.5)).toBe(1)
    expect(gridLineWidth(2)).toBe(1)
  })

  it('places the first checkerboard boundary where the canvas tile does', () => {
    // `fillTileBox` needs a canvas and this suite has no DOM (see
    // paint-tile.unit.spec.ts), so the pixel-level half of this claim is the
    // browser proof in the report — `fillTileBox`'s own ImageData against the
    // rasterised `<pattern>`, byte-identical. What CAN be pinned here is the
    // number both of them index by: at density 8 on a 100-wide box the first
    // boundary is at 12.5, so pixel 12 is `a` and 13 is `b`. Under the old
    // rounded cell (13) pixel 13 was still `a`.
    const cell = fillPatternCell(100, 8)
    expect(cell).toBe(12.5)
    expect(checkerCellIsB(Math.floor(12 / cell), 0)).toBe(false)
    expect(checkerCellIsB(Math.floor(13 / cell), 0)).toBe(true)
  })
})

// ── the spine: <pattern> as a paint server ──────────────────────────────────

describe('<pattern> — one per DISTINCT value, not one per shape', () => {
  const tile: VectorPattern = {
    type: 'pattern',
    width: 20,
    height: 20,
    background: '#ffffff',
    rects: [{ x: 0, y: 0, width: 10, height: 10, fill: '#000000' }],
  }

  it('collapses 40 shapes sharing a tile into ONE paint server', () => {
    const shapes: VectorShape[] = []
    for (let i = 0; i < 40; i++) shapes.push({ commands: square(i * 4), fill: { ...tile } })
    const svg = shapesToSVG(shapes, DOC)
    expect((svg.match(/<pattern /g) ?? []).length).toBe(1)
    expect((svg.match(/fill="url\(#[^"]*-p0\)"/g) ?? []).length).toBe(40)
  })

  it('keeps genuinely different tiles apart, numbered in first-use order', () => {
    const svg = shapesToSVG([
      { commands: square(10), fill: { ...tile } },
      { commands: square(30), fill: { ...tile, width: 40 } },
      { commands: square(50), fill: { ...tile } },
    ], DOC)
    const ids = [...svg.matchAll(/<pattern id="([^"]+)"/g)].map(m => m[1] as string)
    expect(ids.length).toBe(2)
    expect(ids[0]!.endsWith('-p0')).toBe(true)
    expect(ids[1]!.endsWith('-p1')).toBe(true)
    expect((svg.match(/-p0\)/g) ?? []).length).toBe(2)
  })

  it('is ALWAYS userSpaceOnUse with the tile at the origin', () => {
    // The placement rides in patternTransform, never in x/y — see VectorPattern.
    const svg = shapesToSVG([{ commands: square(10), fill: { ...tile } }], DOC)
    expect(svg).toContain('patternUnits="userSpaceOnUse"')
    expect(svg).toContain('width="20" height="20"')
    expect(svg).not.toMatch(/<pattern[^>]* x="/)
    expect(svg).not.toContain('objectBoundingBox')
  })

  it('writes patternTransform as a matrix, and nothing when there is none', () => {
    const moved = shapesToSVG([{ commands: square(10), fill: { ...tile, transform: [1, 0, 0, 1, -30, 7] } }], DOC)
    expect(moved).toContain('patternTransform="matrix(1 0 0 1 -30 7)"')
    expect(shapesToSVG([{ commands: square(10), fill: { ...tile } }], DOC)).not.toContain('patternTransform')
  })

  it('paints the background as real geometry, and omits it when absent', () => {
    const withBg = shapesToSVG([{ commands: square(10), fill: { ...tile } }], DOC)
    expect(withBg).toContain('<rect width="20" height="20" fill="#ffffff"/>')
    const bare = shapesToSVG([{ commands: square(10), fill: { ...tile, background: null } }], DOC)
    expect(bare).toMatch(/<pattern[^>]*><rect x="0"/)
  })

  it('numbers patterns and gradients independently in one document', () => {
    const svg = shapesToSVG([
      { commands: square(10), fill: { ...tile } },
      { commands: square(30), fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] } },
    ], DOC)
    expect(svg).toMatch(/<linearGradient id="[^"]+-g0"/)
    expect(svg).toMatch(/<pattern id="[^"]+-p0"/)
    expect(svg).toMatch(/fill="url\(#[^"]+-p0\)"/)
    expect(svg).toMatch(/fill="url\(#[^"]+-g0\)"/)
  })

  it('leaves a pattern-free document hashing exactly as it did before', () => {
    // Same guarantee task 4 pinned for gradients: adding a third registry must
    // not churn the ids of every file already exported.
    const svg = shapesToSVG([{ commands: square(10), fill: '#abcdef', blur: 4 }], DOC)
    const prefix = defsIdPrefix('0 0 200 100|4||<path d="M10 10L20 10L20 20L10 20Z" fill="#abcdef"/>')
    expect(svg).toContain(`id="${prefix}-b0"`)
  })

  it('ids differ when only the PATTERN differs — same geometry, different tile', () => {
    const a = shapesToSVG([{ commands: square(10), fill: { ...tile } }], DOC)
    const b = shapesToSVG([{ commands: square(10), fill: { ...tile, rects: [{ x: 0, y: 0, width: 5, height: 5, fill: '#000000' }] } }], DOC)
    const idOf = (s: string) => /<pattern id="([^"]+)"/.exec(s)![1] as string
    expect(idOf(a)).not.toBe(idOf(b))
    expect(a).toBe(shapesToSVG([{ commands: square(10), fill: { ...tile } }], DOC))
  })

  it('guards the union — a pattern is not a gradient and vice versa', () => {
    expect(isVectorPattern(tile)).toBe(true)
    expect(isVectorPattern('#fff')).toBe(false)
    expect(isVectorPattern(null)).toBe(false)
    expect(isVectorPattern({ type: 'linear', stops: [] } as never)).toBe(false)
  })
})

// ── the adapter: a Fill's four procedural kinds ─────────────────────────────

describe('paintToVectorPaint — the four procedural fills as real geometry', () => {
  const cell = fillPatternCell(UNIT_BOX.width, 8)

  it('sizes every tile from fillPatternCell, not from a second derivation', () => {
    expect(pattern('grid').width).toBeCloseTo(cell, 10)
    expect(pattern('checkerboard').width).toBeCloseTo(cell * 2, 10)
    expect(pattern('stripes').width).toBeCloseTo(cell * 2, 10)
    expect(pattern('qr').width).toBe(UNIT_BOX.width)      // not periodic — the tile IS the box
  })

  it('rules a grid with ONE whole rect per axis, never two halves at the seam', () => {
    // The measured bug: two abutting half-width rects on opposite edges of a
    // fractional tile lose ink in Chrome (0.73 units where 1 was asked for),
    // which reads as a uniform tint and passes every geometry check. The lines
    // are whole and the LATTICE is shifted back by half a line instead.
    const p = pattern('grid')
    const lw = gridLineWidth(cell)
    expect(p.rects.length).toBe(2)
    expect(p.rects[0]).toEqual({ x: 0, y: 0, width: lw, height: cell, fill: '#111111' })
    expect(p.rects[1]).toEqual({ x: 0, y: 0, width: cell, height: lw, fill: '#111111' })
    expect(p.background).toBe('#ffe600')
    expect(p.transform).toEqual([1, 0, 0, 1, UNIT_BOX.x - lw / 2, UNIT_BOX.y - lw / 2])
  })

  it('lays a checkerboard on the ODD diagonals, so cell (0,0) is `a`', () => {
    const p = pattern('checkerboard')
    expect(p.background).toBe('#ffe600')
    expect(p.rects.map(r => [r.x / cell, r.y / cell])).toEqual([[1, 0], [0, 1]])
    expect(p.rects.every(r => r.fill === '#111111' && r.width === cell && r.height === cell)).toBe(true)
  })

  it('rotates a stripe tile rather than re-deriving the dot product', () => {
    const p = pattern('stripes', { angle: 35 })
    const rad = (35 * Math.PI) / 180
    const c = Math.cos(rad), s = Math.sin(rad)
    // translate(box) · rotate(35): the rotation is the linear part, untouched.
    expect(p.transform![0]).toBeCloseTo(c, 10)
    expect(p.transform![1]).toBeCloseTo(s, 10)
    expect(p.transform![2]).toBeCloseTo(-s, 10)
    expect(p.transform![3]).toBeCloseTo(c, 10)
    expect(p.transform![4]).toBe(UNIT_BOX.x)
    expect(p.transform![5]).toBe(UNIT_BOX.y)
    // One `b` band of width `cell` at `cell`, exactly `stripeBandIsB`'s rule.
    expect(p.rects).toEqual([{ x: cell, y: 0, width: cell, height: cell * 2, fill: '#111111' }])
  })

  it('leaves an axis-aligned stripe with no rotation at all', () => {
    const zero = pattern('stripes', { angle: 0 }, { x: 0, y: 0, width: 240, height: 120 })
    expect(zero.transform).toBeUndefined()
    const ninety = pattern('stripes', { angle: 90 }, { x: 0, y: 0, width: 240, height: 120 })
    expect(ninety.transform![0]).toBeCloseTo(0, 12)
    expect(ninety.transform![1]).toBeCloseTo(1, 12)
  })

  it('draws every qr cell the canvas hash turns on, merged into runs', () => {
    const box = { x: 0, y: 0, width: 240, height: 120 }
    const p = pattern('qr', { density: 8 }, box)
    const c = fillPatternCell(box.width, 8)
    const cols = Math.ceil(box.width / c), rows = Math.ceil(box.height / c)
    // Rebuild the expected coverage from the predicate and compare as a set of
    // covered cells, so the run merge cannot silently drop or add one.
    const covered = new Set<string>()
    for (const r of p.rects) {
      for (let cx = Math.round(r.x / c); cx < Math.round((r.x + r.width) / c); cx++) {
        covered.add(`${cx},${Math.round(r.y / c)}`)
      }
    }
    const expected = new Set<string>()
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) if (qrCellIsB(cx, cy)) expected.add(`${cx},${cy}`)
    expect(covered).toEqual(expected)
    expect(expected.size).toBeGreaterThan(10)
    // The merge did something — fewer rects than cells.
    expect(p.rects.length).toBeLessThan(expected.size)
  })

  it('never lets a qr rect spill past the box it is anchored to', () => {
    const box = { x: 0, y: 0, width: 250, height: 130 }     // cells do not divide it
    const p = pattern('qr', { density: 8 }, box)
    for (const r of p.rects) {
      expect(r.x + r.width).toBeLessThanOrEqual(box.width + 1e-9)
      expect(r.y + r.height).toBeLessThanOrEqual(box.height + 1e-9)
    }
  })

  it('anchors the lattice to the BOX corner, wherever that is', () => {
    const p = pattern('checkerboard', {}, { x: 37.5, y: -12, width: 240, height: 120 })
    expect(p.transform).toEqual([1, 0, 0, 1, 37.5, -12])
  })

  it('cancels the referencing shape\'s transform under a run anchor', () => {
    const element: Affine = [0.5, 0.25, -0.25, 0.5, 40, 10]
    const p = paintToVectorPaint(fill('checkerboard'), {
      units: 'userSpaceOnUse', box: UNIT_BOX, elementTransform: element,
    }) as VectorPattern
    // transform = element⁻¹ · translate(box), so composing the element back on
    // leaves exactly the lattice placement.
    const composed = multiplyAffine(element, p.transform!)
    expect(composed.map(v => +v.toFixed(9))).toEqual([1, 0, 0, 1, UNIT_BOX.x, UNIT_BOX.y])
  })

  it('does NOT cancel it under the per-shape anchor — the pattern rides the letter', () => {
    const box = { x: 37.5, y: -12, width: 240, height: 120 }
    const p = paintToVectorPaint(fill('checkerboard'), {
      units: 'objectBoundingBox', box, elementTransform: [0.5, 0, 0, 0.5, 40, 10], aspect: 2,
    }) as VectorPattern
    // The box translate and NOTHING else — no inverse anywhere in it.
    expect(p.transform).toEqual([1, 0, 0, 1, box.x, box.y])
  })

  it('refuses to guess a lattice with no box, and stays on the bridge', () => {
    for (const type of ['grid', 'checkerboard', 'stripes', 'qr'] as FillType[]) {
      expect(paintToVectorPaint(fill(type), { units: 'objectBoundingBox' })).toBeNull()
      expect(paintToVectorPaint(fill(type), { units: 'userSpaceOnUse', box: { x: 0, y: 0, width: 0, height: 10 } })).toBeNull()
    }
  })

  it('still returns NULL for the three kinds that have no cell structure', () => {
    for (const type of ['ombre', 'noise', 'shader'] as FillType[]) {
      expect(paintToVectorPaint(fill(type), { units: 'userSpaceOnUse', box: UNIT_BOX })).toBeNull()
    }
  })

  it('reports the export tier by KIND, not by the arguments it was asked with', () => {
    for (const type of ['grid', 'checkerboard', 'stripes', 'qr'] as FillType[]) {
      expect(paintIsVector(fill(type))).toBe(true)
    }
    for (const type of ['ombre', 'noise', 'shader'] as FillType[]) {
      expect(paintIsVector(fill(type))).toBe(false)
    }
    expect(paintIsVector(fill('solid'))).toBe(true)
    expect(paintIsVector(fill('gradient'))).toBe(true)
  })
})

// ── Vector Type: the four kinds through the real export ─────────────────────

describe('vectorTypeSVG — the procedural fills export as real vector', () => {
  const KINDS: FillType[] = ['grid', 'checkerboard', 'stripes', 'qr']

  it('emits a <pattern> for every one of the four, on every anchor', () => {
    for (const type of KINDS) {
      for (const anchor of ['glyph', 'word', 'frame']) {
        const { svg } = vectorTypeSVG(font, cfg({ fill: fill(type), fillAnchor: anchor }), 0, BOX)
        expect((svg.match(/<pattern /g) ?? []).length).toBeGreaterThan(0)
        expect(svg).toMatch(/fill="url\(#[^"]+-p\d+\)"/)
        // No PATH fell back to the bridge colour — `#ffe600` still appears,
        // but only as the pattern tile's own background rect.
        expect(svg).not.toMatch(/<path[^>]*fill="#ffe600"/)
      }
    }
  })

  it('anchors a per-glyph pattern to EXACTLY vtGlyphPaintBox', () => {
    const c = cfg({ fill: fill('checkerboard'), fillAnchor: 'glyph' })
    const frame = vectorTypeFrame(font, c, 0)
    const place = vtPlacement(frame, BOX)
    const em = place.scale * (frame.outlines.unitsPerEm || 1000)
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    const boxes = frame.outlines.glyphs.map(g => vtGlyphPaintBox(g, place, em))
    const transforms = [...svg.matchAll(/patternTransform="matrix\(1 0 0 1 ([-\d.]+) ([-\d.]+)\)"/g)]
      .map(m => [Number(m[1]), Number(m[2])])
    expect(transforms.length).toBe(boxes.length)
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!
      expect(transforms[i]![0]).toBeCloseTo(b.cx - b.w / 2, 3)
      expect(transforms[i]![1]).toBeCloseTo(b.cy - b.h / 2, 3)
    }
    // Each letter carries its own copy — that is what the anchor MEANS.
    expect(new Set(transforms.map(t => t.join(','))).size).toBe(boxes.length)
  })

  it('spans ONE pattern over vtRunPaintBox for a still word', () => {
    const c = cfg({ fill: fill('checkerboard'), fillAnchor: 'word' })
    const frame = vectorTypeFrame(font, c, 0)
    const place = vtPlacement(frame, BOX)
    const box = vtRunPaintBox(frame.outlines, place, BOX)
    const { svg } = vectorTypeSVG(font, c, 0, BOX)
    expect((svg.match(/<pattern /g) ?? []).length).toBe(1)
    const m = /patternTransform="matrix\(1 0 0 1 ([-\d.]+) ([-\d.]+)\)"/.exec(svg)!
    expect(Number(m[1])).toBeCloseTo(box.cx - box.w / 2, 3)
    expect(Number(m[2])).toBeCloseTo(box.cy - box.h / 2, 3)
    const cell = fillPatternCell(box.w, 8)
    expect(svg).toContain(`width="${(cell * 2).toFixed(3)}"`)
  })

  it('holds a run-anchored lattice STILL while the type moves over it', () => {
    // A flat `motion.tracks` array is the pre-Task-4 shape and is ONLY read by
    // `mergeConfig` when `motion.moves` is absent (`hasNewShape`/`hasOldShape`
    // in `~/lib/vectortype/config`). `DEFAULT_CONFIG.motion.moves` is already
    // `[]` (an array), so spreading it in here makes `hasNewShape` true and the
    // `tracks` key below would be silently ignored. Since the 2026-09-04 moves
    // redesign a hand-authored track travels as a `kind: 'tracks'` move — see
    // `vectortype-preset-motion.unit.spec.ts`'s `trackMove` for the same shape.
    const moving = mergeConfig({
      ...cfg({ fill: fill('checkerboard'), fillAnchor: 'word' }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        moves: [{
          id: 'move-drift',
          kind: 'tracks',
          presetId: 'custom',
          at: 0,
          duration: DEFAULT_CONFIG.motion.duration,
          loop: true,
          ease: { kind: 'named', name: 'none' },
          tracks: [{ path: 'glyph.dx', from: -40, to: 40, hold: 0, cycleOffset: 0, delay: 0 }],
        }],
        stagger: { delay: 0.12, order: 'first-to-last', seed: 0 },
      },
    } as never)
    const { svg } = vectorTypeSVG(font, moving, 0.37, BOX)
    // One server per DISTINCT glyph transform, each carrying that transform's
    // inverse — the same correction a userSpaceOnUse gradient needs, for the
    // same reason (task 4, measured in Chrome).
    const patterns = [...svg.matchAll(/patternTransform="matrix\(([^)]+)\)"/g)].map(m => (m[1] as string).split(' ').map(Number))
    expect(patterns.length).toBeGreaterThan(1)
    const glyphTransforms = [...svg.matchAll(/<path[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)[^"]*translate\(([-\d.]+) ([-\d.]+)\)"/g)]
    expect(glyphTransforms.length).toBeGreaterThan(0)
    // Every emitted matrix must be a pure translate: the inverse of a translate
    // composed with the box translate leaves no rotation or scale behind.
    for (const p of patterns) expect([p[0], p[1], p[2], p[3]]).toEqual([1, 0, 0, 1])
    expect(new Set(patterns.map(p => p.join(','))).size).toBeGreaterThan(1)
  })

  it('still degrades the three raster-only kinds to a flat colour — the bridge', () => {
    for (const type of ['ombre', 'noise', 'shader'] as FillType[]) {
      const { svg } = vectorTypeSVG(font, cfg({ fill: fill(type) }), 0, BOX)
      expect(svg).not.toContain('<pattern')
      expect(svg).toContain('fill="#ffe600"')
    }
  })

  it('carries no raster of any kind, on every kind and every anchor', () => {
    for (const type of KINDS) {
      for (const anchor of ['glyph', 'word', 'frame']) {
        const { svg } = vectorTypeSVG(font, cfg({ fill: fill(type), fillAnchor: anchor }), 0, BOX)
        expect(svg).not.toMatch(/<image|base64|data:image|feImage|xlink:href/)
        expect(svg).toMatch(/<path d="M/)
      }
    }
  })
})
