/**
 * Vector Type — outline extraction and the two renderers.
 *
 * This is the best test leverage in the product: path commands are plain arrays
 * of numbers, so the engine can be pinned exactly, with no canvas and no GPU.
 *
 * The load-bearing test is `keeps command COUNT constant as an axis moves`.
 * Variable-font `gvar` deltas move existing points and never add or remove
 * them, so outlines at any two axis positions correspond point-for-point and
 * animating between them is safe by construction. If that ever stops holding,
 * animation breaks subtly and almost undebuggably — this test is the guard.
 *
 * NO NETWORK. The font is a local fixture: Inter's variable TTF subset to eight
 * characters with fontTools (6.8 KB, SIL OFL 1.1, licence checked in beside
 * it). `fvar`, `gvar` and `avar` survive the subset, so it is a real variable
 * font and not a static cut pretending to be one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterEach, describe, expect, it } from 'vitest'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { commandCount, textOutlines } from '~/lib/vectortype/outline'
import type { PathCommand, TextOutlines } from '~/lib/vectortype/outline'
import {
  fitTransform,
  outlinesToPath2D,
  outlinesToSVG,
  placeOutlines,
  shapesToSVG,
} from '~/lib/vectortype/render'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
const STATIC_FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-static.ttf', import.meta.url))

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

/** A STATIC cut — a Google family or a library face, `VtFont.axes === []`. No
 *  `fvar`, so fontkit's own `raw` IS the instance; there is no `getVariation`
 *  to call. This is the shape every "any font" pick that isn't a variable
 *  font takes, and it is the fixture the live bug (picking a Google family
 *  threw on every preview frame) never had a test through `textOutlines`. */
function loadStaticFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(STATIC_FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'google:Inter@700',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}

const font = loadFixtureFont()

/** Every coordinate in a run, in order. Used to prove geometry actually moved. */
function flatCoords(o: TextOutlines): number[] {
  return o.glyphs.flatMap(g => g.commands.flatMap(c => c.args))
}

function commandNames(o: TextOutlines): string[] {
  return o.glyphs.flatMap(g => g.commands.map(c => c.command))
}

function maxAbsDelta(a: number[], b: number[]): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)))
  return m
}

describe('vectortype fixture', () => {
  it('is a real variable font, not a static cut', () => {
    expect(font.axes.map(a => a.tag).sort()).toEqual(['opsz', 'wght'])
    const wght = font.axes.find(a => a.tag === 'wght')!
    expect(wght.min).toBe(100)
    expect(wght.max).toBe(900)
    expect(font.unitsPerEm).toBe(2048)
  })
})

describe('textOutlines', () => {
  it('produces one outline per glyph with a positive advance', () => {
    const o = textOutlines(font, 'Sailor', { wght: 400 })
    expect(o.glyphs).toHaveLength(6)
    for (const g of o.glyphs) {
      expect(g.commands.length).toBeGreaterThan(0)
      expect(g.advance).toBeGreaterThan(0)
      expect(g.commands[0]!.command).toBe('moveTo')
    }
    expect(o.unitsPerEm).toBe(2048)
    // The pen ends where the advances say it does.
    expect(o.width).toBeCloseTo(o.glyphs.reduce((s, g) => s + g.advance, 0), 6)
    // Glyphs are laid out left to right, each at the running pen position.
    expect(o.glyphs[0]!.x).toBe(0)
    expect(o.glyphs[1]!.x).toBeCloseTo(o.glyphs[0]!.advance, 6)
  })

  it('returns an empty run for empty text without touching the font', () => {
    const o = textOutlines(font, '', { wght: 400 })
    expect(o.glyphs).toEqual([])
    expect(o.width).toBe(0)
    expect(o.bbox).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('emits only the five known path commands', () => {
    const names = new Set(commandNames(textOutlines(font, 'Sailorg', { wght: 700 })))
    for (const n of names) {
      expect(['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'closePath']).toContain(n)
    }
    // Arity is fixed per command — renderers index args positionally.
    const arity: Record<string, number> = {
      moveTo: 2, lineTo: 2, quadraticCurveTo: 4, bezierCurveTo: 6, closePath: 0,
    }
    for (const g of textOutlines(font, 'Sailorg', { wght: 700 }).glyphs) {
      for (const c of g.commands) expect(c.args).toHaveLength(arity[c.command]!)
    }
  })

  it('keeps command COUNT constant as an axis moves — the property that makes animation safe', () => {
    const a = textOutlines(font, 'g', { wght: 100 })
    const b = textOutlines(font, 'g', { wght: 900 })
    expect(a.glyphs[0]!.commands.length).toBe(b.glyphs[0]!.commands.length)
    // The spike measured 46 for Inter's `g`; the subset reproduces it exactly.
    expect(a.glyphs[0]!.commands.length).toBe(46)

    // …and across the whole sweep, for a multi-glyph run, on both axes.
    const counts = new Set<number>()
    const sequences = new Set<string>()
    for (const wght of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      for (const opsz of [14, 23, 32]) {
        const o = textOutlines(font, 'Sailorg', { wght, opsz })
        counts.add(commandCount(o))
        sequences.add(commandNames(o).join(','))
      }
    }
    expect(counts.size).toBe(1)
    // Stronger than the count: the command SEQUENCE is identical too, which is
    // what makes index-wise interpolation between two positions meaningful.
    expect(sequences.size).toBe(1)
  })

  it('moves the outline as the axis moves', () => {
    const light = textOutlines(font, 'g', { wght: 100 })
    const bold = textOutlines(font, 'g', { wght: 900 })
    const a = flatCoords(light)
    const b = flatCoords(bold)
    expect(a).toHaveLength(b.length)
    // Comparing LENGTHS here would pass vacuously — the point of the test above
    // is that they are always equal. Compare coordinates.
    expect(a).not.toEqual(b)
    expect(maxAbsDelta(a, b)).toBeGreaterThan(20) // font units, upem 2048
    // Ink gets wider with weight, monotonically.
    const widths = [100, 400, 700, 900].map(w => {
      const o = textOutlines(font, 'g', { wght: w })
      return o.bbox.maxX - o.bbox.minX
    })
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!)

    // The second axis moves geometry too — opsz is not a no-op we forgot to pass.
    const small = flatCoords(textOutlines(font, 'g', { wght: 400, opsz: 14 }))
    const large = flatCoords(textOutlines(font, 'g', { wght: 400, opsz: 32 }))
    expect(small).not.toEqual(large)
  })

  it("clamps an out-of-range axis value to the font's own range", () => {
    const over = textOutlines(font, 'g', { wght: 5000 })
    const max = textOutlines(font, 'g', { wght: 900 })
    expect(over.coords.wght).toBe(900)
    expect(flatCoords(over)).toEqual(flatCoords(max))

    const under = textOutlines(font, 'g', { wght: -100 })
    expect(under.coords.wght).toBe(100)
    expect(flatCoords(under)).toEqual(flatCoords(textOutlines(font, 'g', { wght: 100 })))
  })

  it('fills unspecified axes with the font default and drops unknown tags', () => {
    const o = textOutlines(font, 'g', { wght: 700, XXXX: 12, wdth: 50 })
    expect(o.coords).toEqual({ opsz: 14, wght: 700 })
    // A junk value is dropped, not passed to fontkit as NaN.
    expect(textOutlines(font, 'g', { wght: Number.NaN }).coords.wght).toBe(400)
  })

  it('handles blank and missing glyphs without poisoning the run bounds', () => {
    // The fixture only carries " Sailorg"; 'Z' falls through to .notdef, and a
    // space has no outline at all. fontkit reports `{minX: null, …}` for both,
    // which must not leak into the run bbox as NaN.
    const o = textOutlines(font, 'a Z', { wght: 400 })
    expect(o.glyphs).toHaveLength(3)
    const space = o.glyphs[1]!
    expect(space.commands).toEqual([])
    expect(space.advance).toBeGreaterThan(0)
    expect(space.bbox).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
    for (const v of Object.values(o.bbox)) expect(Number.isFinite(v)).toBe(true)
    // Only the real 'a' contributes ink, so the run bounds are that glyph's.
    expect(o.bbox.minX).toBeCloseTo(o.glyphs[0]!.bbox.minX, 6)
  })

  it('does not hand out references into fontkit\'s cached glyph paths', () => {
    const a = textOutlines(font, 'g', { wght: 400 })
    const before = a.glyphs[0]!.commands[0]!.args[0]
    a.glyphs[0]!.commands[0]!.args[0] = 99999
    const b = textOutlines(font, 'g', { wght: 400 })
    expect(b.glyphs[0]!.commands[0]!.args[0]).toBe(before)
  })
})

describe('render — placement', () => {
  it('bakes scale, offset and the y flip into the coordinates', () => {
    const o = textOutlines(font, 'S', { wght: 400 })
    const raw = o.glyphs[0]!.commands[0]!.args
    const placed = placeOutlines(o, { scale: 0.5, x: 10, y: 20 })[0]!
    expect(placed[0]!.args[0]).toBeCloseTo(10 + raw[0]! * 0.5, 6)
    // y-up font space becomes y-down output space.
    expect(placed[0]!.args[1]).toBeCloseTo(20 - raw[1]! * 0.5, 6)

    const unflipped = placeOutlines(o, { scale: 0.5, x: 10, y: 20, flipY: false })[0]!
    expect(unflipped[0]!.args[1]).toBeCloseTo(20 + raw[1]! * 0.5, 6)
  })

  it('offsets each glyph by its own pen position', () => {
    const o = textOutlines(font, 'ai', { wght: 400 })
    const placed = placeOutlines(o, { scale: 2 })
    const first = placed[0]![0]!.args[0]!
    const second = placed[1]![0]!.args[0]!
    const localDelta = o.glyphs[1]!.commands[0]!.args[0]! - o.glyphs[0]!.commands[0]!.args[0]!
    expect(second - first).toBeCloseTo((o.glyphs[0]!.advance + localDelta) * 2, 6)
  })

  it('fits a run inside a box, centred, without overflowing the padding', () => {
    const o = textOutlines(font, 'Sailor', { wght: 400 })
    const t = fitTransform(o.bbox, { width: 400, height: 200, padding: 20 })
    const pts = placeOutlines(o, t).flatMap(cs => cs.flatMap(c => c.args))
    const xs = pts.filter((_, i) => i % 2 === 0)
    const ys = pts.filter((_, i) => i % 2 === 1)
    // Control points can bulge past the ink bounds, so allow a small slack and
    // assert the important thing: it is inside the box, and it is centred.
    expect(Math.min(...xs)).toBeGreaterThan(15)
    expect(Math.max(...xs)).toBeLessThan(385)
    expect(Math.min(...ys)).toBeGreaterThan(15)
    expect(Math.max(...ys)).toBeLessThan(185)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    expect(cx).toBeGreaterThan(150)
    expect(cx).toBeLessThan(250)
  })
})

/** Parse an SVG `d` back into the command list it came from. Deliberately
 *  strict — it must reject anything the writer would not have emitted. */
function parsePathData(d: string): PathCommand[] {
  const tokens = d.match(/[MLQCZ][^MLQCZ]*/g) ?? []
  const arity: Record<string, [PathCommand['command'], number]> = {
    M: ['moveTo', 2], L: ['lineTo', 2], Q: ['quadraticCurveTo', 4], C: ['bezierCurveTo', 6], Z: ['closePath', 0],
  }
  return tokens.map(tok => {
    const [command, n] = arity[tok[0] as string]!
    const args = (tok.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (args.length !== n) throw new Error(`bad "${tok}": expected ${n} args, got ${args.length}`)
    return { command, args }
  })
}

describe('render — SVG export round-trips the same geometry', () => {
  const opts = { scale: 0.25, x: 40, y: 300, precision: 4 } as const
  const o = textOutlines(font, 'Sailor', { wght: 620 })

  it('emits one path per glyph whose d re-parses to the placed commands', () => {
    const svg = outlinesToSVG(o, { ...opts, fill: '#f2622e' })
    const ds = [...svg.matchAll(/ d="([^"]+)"/g)].map(m => m[1] as string)
    const placed = placeOutlines(o, opts)
    expect(ds).toHaveLength(placed.length)
    for (let i = 0; i < ds.length; i++) {
      const parsed = parsePathData(ds[i] as string)
      const expected = placed[i] as PathCommand[]
      expect(parsed.map(c => c.command)).toEqual(expected.map(c => c.command))
      for (let j = 0; j < parsed.length; j++) {
        for (let k = 0; k < parsed[j]!.args.length; k++) {
          // 4 decimals of precision in, 4 decimals of agreement out.
          expect(parsed[j]!.args[k]).toBeCloseTo(expected[j]!.args[k] as number, 4)
        }
      }
    }
  })

  it('describes the SAME geometry the canvas renderer draws', () => {
    // Record what Path2D would receive, then compare it to the parsed SVG.
    const calls: PathCommand[][] = []
    class RecordingPath2D {
      cmds: PathCommand[] = []
      constructor() { calls.push(this.cmds) }
      moveTo(...a: number[]) { this.cmds.push({ command: 'moveTo', args: a }) }
      lineTo(...a: number[]) { this.cmds.push({ command: 'lineTo', args: a }) }
      quadraticCurveTo(...a: number[]) { this.cmds.push({ command: 'quadraticCurveTo', args: a }) }
      bezierCurveTo(...a: number[]) { this.cmds.push({ command: 'bezierCurveTo', args: a }) }
      closePath() { this.cmds.push({ command: 'closePath', args: [] }) }
    }
    ;(globalThis as any).Path2D = RecordingPath2D

    outlinesToPath2D(o, opts)
    const ds = [...outlinesToSVG(o, opts).matchAll(/ d="([^"]+)"/g)].map(m => m[1] as string)

    expect(calls).toHaveLength(ds.length)
    expect(calls.reduce((n, c) => n + c.length, 0)).toBe(commandCount(o))
    for (let i = 0; i < ds.length; i++) {
      const fromSvg = parsePathData(ds[i] as string)
      const fromCanvas = calls[i] as PathCommand[]
      expect(fromSvg.map(c => c.command)).toEqual(fromCanvas.map(c => c.command))
      for (let j = 0; j < fromSvg.length; j++) {
        for (let k = 0; k < fromSvg[j]!.args.length; k++) {
          expect(fromSvg[j]!.args[k]).toBeCloseTo(fromCanvas[j]!.args[k] as number, 4)
        }
      }
    }
  })

  afterEach(() => { delete (globalThis as any).Path2D })

  it('throws a clear error rather than half-drawing where Path2D is absent', () => {
    delete (globalThis as any).Path2D
    expect(() => outlinesToPath2D(o)).toThrow(/Path2D is unavailable/)
  })

  it('sizes the document to the placed ink when no viewBox is given', () => {
    const svg = outlinesToSVG(o, { scale: 0.25, padding: 8 })
    const vb = (svg.match(/viewBox="([^"]+)"/) as RegExpMatchArray)[1]!.split(' ').map(Number)
    expect(vb[2]).toBeCloseTo((o.bbox.maxX - o.bbox.minX) * 0.25 + 16, 1)
    expect(vb[3]).toBeCloseTo((o.bbox.maxY - o.bbox.minY) * 0.25 + 16, 1)
  })

  it('carries paint through, including per-glyph fills', () => {
    const svg = outlinesToSVG(o, {
      scale: 0.25,
      fill: (_g, i) => (i % 2 ? '#fff' : '#000'),
      stroke: '#f2622e',
      strokeWidth: 1.5,
      background: '#111',
    })
    expect(svg).toContain('fill="#000"')
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('stroke="#f2622e"')
    expect(svg).toContain('stroke-width="1.5"')
    expect(svg).toContain('<rect')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
  })
})

describe('the SVG writer is not type-specific', () => {
  it('serialises shapes that never came from a font — Shape Studio\'s case', () => {
    // A flat-shaded triangle facet, as a projected polygon.
    const svg = shapesToSVG(
      [{
        commands: [
          { command: 'moveTo', args: [0, 0] },
          { command: 'lineTo', args: [10, 0] },
          { command: 'lineTo', args: [5, 8] },
          { command: 'closePath', args: [] },
        ],
        fill: '#3af',
        attrs: { 'data-facet': 7 },
      }],
      { viewBox: [0, 0, 10, 8] },
    )
    expect(svg).toContain('d="M0 0L10 0L5 8Z"')
    expect(svg).toContain('data-facet="7"')
    expect(svg).toContain('viewBox="0 0 10 8"')
    expect(svg).not.toMatch(/font|glyph|text/i)
  })

  it('escapes attribute values rather than emitting broken XML', () => {
    const svg = shapesToSVG(
      [{ commands: [{ command: 'moveTo', args: [0, 0] }, { command: 'lineTo', args: [1, 1] }], attrs: { 'data-label': 'a & "b" <c>' } }],
      { viewBox: [0, 0, 1, 1] },
    )
    expect(svg).toContain('data-label="a &amp; &quot;b&quot; &lt;c&gt;"')
  })
})

describe('textOutlines on a STATIC font (no fvar/gvar) — the "any font" program', () => {
  const staticFont = loadStaticFixtureFont()

  it('is a static cut, not a variable font', () => {
    expect(staticFont.axes).toEqual([])
  })

  it('shapes without calling fontkit\'s getVariation, and reports empty coords', () => {
    // fontkit throws "Variations require a font with the fvar, gvar and glyf,
    // or CFF2 tables" the moment `getVariation` is called on a font with no
    // `fvar` — this is the exact live-found crash (picking a Google family
    // blanked every preview frame). A static font has no axes to place, so
    // there is nothing for `coords` to report either.
    const o = textOutlines(staticFont, 'Sailor', {})
    expect(o.glyphs).toHaveLength(6)
    for (const g of o.glyphs) expect(g.commands.length).toBeGreaterThan(0)
    expect(o.coords).toEqual({})
  })
})
