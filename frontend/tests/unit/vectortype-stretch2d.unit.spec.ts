/**
 * 2D deformation-field stretch — SPIKE probes (2026-09-02).
 *
 * Measures `stretch2d.ts` against the shipped slice engine with the probes
 * from the stretch spec's laws: inflection counts (harmony), ring thickness
 * by angle, zone alignment, stem width. Only the invariants and ONE headline
 * target are asserted; the rest is a comparison table written to
 * /tmp/spike-2d.txt (console output is swallowed under vitest).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import type { PathCommand, TextOutlines } from '~/lib/vectortype/outline'
import { stretchOutlines } from '~/lib/vectortype/stretch'
import { DEFAULT_FIELD_OPTIONS, deformLattice, latticeFolds, mapPoint, stretchOutlines2D, stretchOutlines2DWithLattices } from '~/lib/vectortype/stretch2d'
import type { Field2DOptions } from '~/lib/vectortype/stretch2d'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
const REPORT = '/tmp/spike-2d.txt'

function loadFont(path: string, id: string): VtFont {
  const bytes = new Uint8Array(readFileSync(path))
  const raw: any = (fontkit as any).create(bytes)
  return { id, axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

const font = loadFont(FIXTURE, 'inter-subset')
const REAL: Array<[string, string]> = [['inter', '/tmp/inter-full.ttf'], ['fraunces', '/tmp/fraunces.ttf'], ['unbounded', '/tmp/unbounded.ttf']]
const real = new Map<string, VtFont>()
for (const [id, p] of REAL) if (existsSync(p)) real.set(id, loadFont(p, id))

// ---------------------------------------------------------------- probes
// Copied from vectortype-stretch.unit.spec.ts so the two files stay
// independent.

function inkRunsAtY(commands: readonly PathCommand[], yLine: number): Array<[number, number]> {
  const xs: number[] = []
  let px = 0, py = 0, sx = 0, sy = 0
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    if ((y0 <= yLine && y1 > yLine) || (y1 <= yLine && y0 > yLine)) xs.push(x0 + ((yLine - y0) / (y1 - y0)) * (x1 - x0))
  }
  const emit = (x1: number, y1: number) => { seg(px, py, x1, y1); px = x1; py = y1 }
  for (const c of commands) {
    const a = c.args
    if (c.command === 'moveTo') { px = a[0]!; py = a[1]!; sx = px; sy = py }
    else if (c.command === 'lineTo') emit(a[0]!, a[1]!)
    else if (c.command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = a as [number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) { const t = i / 32, u = 1 - t; emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y) }
    } else if (c.command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) { const t = i / 32, u = 1 - t; emit(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y) }
    } else if (c.command === 'closePath') emit(sx, sy)
  }
  xs.sort((a, b) => a - b)
  const runs: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) runs.push([xs[i]!, xs[i + 1]!])
  return runs
}

function inkRunsAtX(commands: readonly PathCommand[], xLine: number): Array<[number, number]> {
  const swapped = commands.map(c => ({ command: c.command, args: c.args.map((v, i) => (i % 2 === 0 ? c.args[i + 1]! : c.args[i - 1]!)) }))
  return inkRunsAtY(swapped, xLine)
}

function subpathsOf(commands: readonly PathCommand[], steps = 24): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = []
  let px = 0, py = 0, sx = 0, sy = 0
  const emit = (x: number, y: number) => { cur.push([x, y]); px = x; py = y }
  for (const c of commands) {
    const a = c.args
    if (c.command === 'moveTo') { if (cur.length > 2) out.push(cur); cur = []; px = a[0]!; py = a[1]!; sx = px; sy = py; cur.push([px, py]) }
    else if (c.command === 'lineTo') emit(a[0]!, a[1]!)
    else if (c.command === 'quadraticCurveTo') { const [cx, cy, x, y] = a as [number, number, number, number]; const x0 = px, y0 = py; for (let i = 1; i <= steps; i++) { const t = i / steps, u = 1 - t; emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y) } }
    else if (c.command === 'bezierCurveTo') { const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]; const x0 = px, y0 = py; for (let i = 1; i <= steps; i++) { const t = i / steps, u = 1 - t; emit(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y) } }
    else if (c.command === 'closePath') emit(sx, sy)
  }
  if (cur.length > 2) out.push(cur)
  return out
}

/** Curvature sign changes along a glyph's contours, ignoring turns under
 *  ~0.6° (flattening noise). A convex ring has 0; an S has 4. */
function inflectionsOf(commands: readonly PathCommand[]): number {
  let total = 0
  for (const poly of subpathsOf(commands)) {
    const n = poly.length
    const turns: number[] = []
    for (let i = 0; i < n; i++) {
      const a = poly[(i - 1 + n) % n]!, b = poly[i]!, c = poly[(i + 1) % n]!
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1]
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy)
      if (lu < 1e-6 || lv < 1e-6) continue
      const sin = (ux * vy - uy * vx) / (lu * lv)
      if (Math.abs(sin) < 0.01) continue
      turns.push(Math.sign(sin))
    }
    for (let i = 1; i < turns.length; i++) if (turns[i] !== turns[i - 1]) total++
  }
  return total
}

/** Ring thickness by angle: 24 buckets around the outer contour's centre,
 *  thickness = nearest distance from each outer sample to the inner
 *  contour. Returns min/max of the bucket means (1 = perfectly even). */
function ringThicknessRatio(commands: readonly PathCommand[], buckets = 24): number {
  const polys = subpathsOf(commands, 64)
  if (polys.length < 2) return NaN
  const area = (p: Array<[number, number]>) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i]!, [x1, y1] = p[(i + 1) % p.length]!; a += x0 * y1 - x1 * y0 } return Math.abs(a) / 2 }
  const sorted = polys.slice().sort((a, b) => area(b) - area(a))
  const outer = sorted[0]!, inner = sorted[1]!
  let cx = 0, cy = 0
  for (const [x, y] of outer) { cx += x; cy += y }
  cx /= outer.length; cy /= outer.length
  const sums = new Float64Array(buckets), counts = new Float64Array(buckets)
  for (const [x, y] of outer) {
    const ang = Math.atan2(y - cy, x - cx)
    const b = Math.min(buckets - 1, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * buckets))
    let best = Infinity
    for (let k = 0; k < inner.length; k++) {
      // point-to-segment distance
      const [ax, ay] = inner[k]!, [bx, by] = inner[(k + 1) % inner.length]!
      const vx = bx - ax, vy = by - ay
      const L2 = vx * vx + vy * vy
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)) : 0
      const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy))
      if (d < best) best = d
    }
    sums[b]! += best; counts[b]! += 1
  }
  let lo = Infinity, hi = -Infinity
  for (let b = 0; b < buckets; b++) { if (!counts[b]) continue; const m = sums[b]! / counts[b]!; lo = Math.min(lo, m); hi = Math.max(hi, m) }
  return lo / hi
}

function glyphOf(o: TextOutlines, ch: string) {
  const g = o.glyphs.find(g => g.codePoints.includes(ch.codePointAt(0)!))
  if (!g) throw new Error(`font has no '${ch}'`)
  return g
}

const count = (o: TextOutlines) => o.glyphs.reduce((n, g) => n + g.commands.length, 0)

const SETTINGS: Array<[number, number]> = [[1, 2.5], [1.8, 1], [0.7, 2.41], [0.5, 1], [0.96, 1.56]]
const EXPAND_SETTINGS: Array<[number, number]> = [[1, 2.5], [1.8, 1], [0.96, 1.56]]
const CONDENSE_SETTINGS: Array<[number, number]> = [[0.7, 2.41], [0.5, 1]]

/** Field options under test — the spike's tuned constants live in
 *  DEFAULT_FIELD_OPTIONS; this is the one place to override for a sweep. */
const FIELD: Field2DOptions = {}

// ------------------------------------------------------------- invariants

describe('2D field — invariants', () => {
  const base = textOutlines(font, 'Sailor')

  it('keeps the command count constant at every setting', () => {
    for (const [s, sy] of SETTINGS) expect(count(stretchOutlines2D(base, s, sy, FIELD))).toBe(count(base))
  })

  it('never folds the lattice under expansion (fixture Sailor)', () => {
    for (const [s, sy] of EXPAND_SETTINGS) {
      const { lattices } = stretchOutlines2DWithLattices(base, s, sy, FIELD)
      for (const l of lattices) if (l) expect(latticeFolds(l), `folds at [${s}, ${sy}]`).toBe(0)
    }
  })

  // STRUCTURAL BLOCKER, recorded: a linearised spring has no barrier against
  // a cell collapsing, and the width target is a HARD constraint, so under
  // condense the whitespace cells (sidebearings, counters) are driven
  // through zero. The compressive barrier (`barrierIters`) halves the fold
  // count and keeps the ink out of the folds, but does not clear it — see
  // docs/superpowers/spikes/2026-09-02-stretch-2d-field-spike.md. Kept as
  // a known failure so the day it passes is visible.
  it.fails('condense settings fold the lattice — known, structural (see spike report)', () => {
    for (const [s, sy] of CONDENSE_SETTINGS) {
      const { lattices } = stretchOutlines2DWithLattices(base, s, sy, FIELD)
      for (const l of lattices) if (l) expect(latticeFolds(l), `folds at [${s}, ${sy}]`).toBe(0)
    }
  })

  it('keeps the baseline fixed', () => {
    for (const [s, sy] of SETTINGS) {
      for (const ch of ['l', 'o', 'a']) {
        const g = glyphOf(base, ch)
        const l = deformLattice(g, s, sy, base.metrics, base.unitsPerEm, FIELD)
        const [, y] = mapPoint(l, (g.bbox.minX + g.bbox.maxX) / 2, 0)
        expect(Math.abs(y), `${ch} baseline at [${s}, ${sy}]`).toBeLessThan(0.5)
      }
    }
  })

  it('solves in bounded time per glyph', () => {
    const { lattices } = stretchOutlines2DWithLattices(base, 1.8, 1, FIELD)
    for (const l of lattices) if (l) expect(l.residual).toBeLessThan(1e-6)
  })
})

// --------------------------------------------------------------- headline

describe('2D field — headline', () => {
  it("the fixture 'o' gains 0 inflections under the field at [1, 2.5] and [1.8, 1]", () => {
    const run = textOutlines(font, 'o')
    expect(inflectionsOf(run.glyphs[0]!.commands)).toBe(0)
    expect(inflectionsOf(stretchOutlines2D(run, 1, 2.5, FIELD).glyphs[0]!.commands)).toBe(0)
    expect(inflectionsOf(stretchOutlines2D(run, 1.8, 1, FIELD).glyphs[0]!.commands)).toBe(0)
  })
})

// ------------------------------------------------------------------ table

describe('2D field — comparison table (report only)', () => {
  it('writes /tmp/spike-2d.txt', () => {
    const lines: string[] = []
    const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a')
    lines.push(`2D deformation-field spike — ${new Date().toISOString()}`)
    lines.push(`field options: ${JSON.stringify({ ...DEFAULT_FIELD_OPTIONS, ...FIELD })}`)
    lines.push('')
    lines.push('INFLECTIONS  (drawn / slice / field)  — lower is better; drawn is the target')
    lines.push('font        glyph  ' + SETTINGS.map(([s, sy]) => `[${s},${sy}]`.padEnd(14)).join(''))
    const cases: Array<[string, VtFont | undefined, string[]]> = [
      ['inter-fix', font, ['o', 'S', 'a', 'l']],
      ['inter', real.get('inter'), ['X', 'Y', 'A', 'o']],
      ['fraunces', real.get('fraunces'), ['a', 'S', 'o']],
      ['unbounded', real.get('unbounded'), ['S', 'a', 'o']],
    ]
    const times: number[] = []
    const iters: number[] = []
    let folds = 0
    let barrier = 0
    const foldsAt = new Map<string, number>()
    for (const [name, f, chars] of cases) {
      if (!f) { lines.push(`${name.padEnd(11)} (font missing)`); continue }
      for (const ch of chars) {
        const run = textOutlines(f, ch)
        const drawn = inflectionsOf(run.glyphs[0]!.commands)
        const cells = SETTINGS.map(([s, sy]) => {
          const slice = inflectionsOf(stretchOutlines(run, s, sy).glyphs[0]!.commands)
          const res = stretchOutlines2DWithLattices(run, s, sy, FIELD)
          const field = inflectionsOf(res.outlines.glyphs[0]!.commands)
          const l = res.lattices[0]!
          const fo = latticeFolds(l)
          times.push(l.ms); iters.push(l.iterations); folds += fo; barrier += l.barrierPasses
          const key = `[${s},${sy}]`
          foldsAt.set(key, (foldsAt.get(key) ?? 0) + fo)
          return `${drawn}/${slice}/${field}${fo ? `f${fo}` : ''}`.padEnd(14)
        })
        lines.push(`${name.padEnd(11)} ${ch.padEnd(6)} ${cells.join('')}`)
      }
    }
    lines.push('(fN = N folded lattice cells at that setting)')
    lines.push('')
    lines.push('RING THICKNESS BY ANGLE  min/max of 24 bucket means (1 = even) — o')
    for (const [name, f] of [['inter-fix', font], ['inter', real.get('inter')], ['fraunces', real.get('fraunces')], ['unbounded', real.get('unbounded')]] as Array<[string, VtFont | undefined]>) {
      if (!f) continue
      const run = textOutlines(f, 'o')
      const drawn = ringThicknessRatio(run.glyphs[0]!.commands)
      const parts = [[1, 2.5], [1.8, 1]].map(([s, sy]) => {
        const slice = ringThicknessRatio(stretchOutlines(run, s!, sy!).glyphs[0]!.commands)
        const field = ringThicknessRatio(stretchOutlines2D(run, s!, sy!, FIELD).glyphs[0]!.commands)
        return `[${s},${sy}] slice ${fmt(slice)} field ${fmt(field)}`
      })
      lines.push(`${name.padEnd(11)} drawn ${fmt(drawn)}   ${parts.join('   ')}`)
    }
    lines.push('')
    lines.push('ZONE ALIGNMENT  top(a)/top(o) at [1, 2.5]  (drawn / slice / field) — should stay ≈ drawn')
    for (const [name, f] of [['inter-fix', font], ['inter', real.get('inter')], ['fraunces', real.get('fraunces')], ['unbounded', real.get('unbounded')]] as Array<[string, VtFont | undefined]>) {
      if (!f) continue
      const run = textOutlines(f, 'ao')
      const a0 = glyphOf(run, 'a'), o0 = glyphOf(run, 'o')
      const sl = stretchOutlines(run, 1, 2.5), fd = stretchOutlines2D(run, 1, 2.5, FIELD)
      const r = (o: TextOutlines) => glyphOf(o, 'a').bbox.maxY / glyphOf(o, 'o').bbox.maxY
      lines.push(`${name.padEnd(11)} ${fmt(a0.bbox.maxY / o0.bbox.maxY, 4)} / ${fmt(r(sl), 4)} / ${fmt(r(fd), 4)}    a top: drawn ${fmt(a0.bbox.maxY, 0)} slice ${fmt(glyphOf(sl, 'a').bbox.maxY, 0)} field ${fmt(glyphOf(fd, 'a').bbox.maxY, 0)}; o top: slice ${fmt(glyphOf(sl, 'o').bbox.maxY, 0)} field ${fmt(glyphOf(fd, 'o').bbox.maxY, 0)}; xHeight×2.5 = ${fmt(run.metrics.xHeight * 2.5, 0)}`)
    }
    lines.push('')
    lines.push("STEM WIDTH  'l' at [0.5, 1] and [2, 1]  new/old  (slice / field) — 1 = stem untouched")
    for (const [name, f] of [['inter-fix', font], ['inter', real.get('inter')], ['fraunces', real.get('fraunces')], ['unbounded', real.get('unbounded')]] as Array<[string, VtFont | undefined]>) {
      if (!f) continue
      const run = textOutlines(f, 'l')
      const g0 = run.glyphs[0]!
      const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
      const w0 = inkRunsAtY(g0.commands, midY).reduce((s, [a, b]) => s + (b - a), 0)
      const parts = [[0.5, 1], [2, 1]].map(([s, sy]) => {
        const ws = inkRunsAtY(stretchOutlines(run, s!, sy!).glyphs[0]!.commands, midY).reduce((q, [a, b]) => q + (b - a), 0)
        const wf = inkRunsAtY(stretchOutlines2D(run, s!, sy!, FIELD).glyphs[0]!.commands, midY).reduce((q, [a, b]) => q + (b - a), 0)
        const wn = inkRunsAtY(stretchOutlines2D(run, s!, sy!, { ...FIELD, barrierIters: 0 }).glyphs[0]!.commands, midY).reduce((q, [a, b]) => q + (b - a), 0)
        return `[${s},${sy}] slice ${fmt(ws / w0, 3)} field ${fmt(wf / w0, 3)} (no barrier ${fmt(wn / w0, 3)})`
      })
      lines.push(`${name.padEnd(11)} ${parts.join('   ')}`)
    }
    lines.push('')
    lines.push("COUNTER / FLANK  'o' at [0.5, 1]  mid-row counter and flank widths new/old (slice / field)")
    for (const [name, f] of [['inter-fix', font], ['inter', real.get('inter')]] as Array<[string, VtFont | undefined]>) {
      if (!f) continue
      const run = textOutlines(f, 'o')
      const g0 = run.glyphs[0]!
      const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
      const r0 = inkRunsAtY(g0.commands, midY)
      const measure = (cmds: PathCommand[]) => {
        const r = inkRunsAtY(cmds, midY)
        if (r.length !== 2 || r0.length !== 2) return 'n/a'
        const counter = (r[1]![0] - r[0]![1]) / (r0[1]![0] - r0[0]![1])
        const flank = ((r[0]![1] - r[0]![0]) + (r[1]![1] - r[1]![0])) / ((r0[0]![1] - r0[0]![0]) + (r0[1]![1] - r0[1]![0]))
        return `counter ${fmt(counter)} flank ${fmt(flank)}`
      }
      lines.push(`${name.padEnd(11)} slice: ${measure(stretchOutlines(run, 0.5, 1).glyphs[0]!.commands)}   field: ${measure(stretchOutlines2D(run, 0.5, 1, FIELD).glyphs[0]!.commands)}`)
    }
    lines.push('')
    lines.push("ARCH THICKNESS  'o' at [1, 2.5]  mid-column arch thickness new/old (slice / field)")
    for (const [name, f] of [['inter-fix', font], ['inter', real.get('inter')]] as Array<[string, VtFont | undefined]>) {
      if (!f) continue
      const run = textOutlines(f, 'o')
      const g0 = run.glyphs[0]!
      const cx = (g0.bbox.minX + g0.bbox.maxX) / 2
      const a0 = inkRunsAtX(g0.commands, cx)
      const m = (o: TextOutlines) => {
        const g = o.glyphs[0]!
        const r = inkRunsAtX(g.commands, (g.bbox.minX + g.bbox.maxX) / 2)
        if (r.length !== 2 || a0.length !== 2) return 'n/a'
        return `bottom ${fmt((r[0]![1] - r[0]![0]) / (a0[0]![1] - a0[0]![0]))} top ${fmt((r[1]![1] - r[1]![0]) / (a0[1]![1] - a0[1]![0]))}`
      }
      lines.push(`${name.padEnd(11)} slice: ${m(stretchOutlines(run, 1, 2.5))}   field: ${m(stretchOutlines2D(run, 1, 2.5, FIELD))}`)
    }
    lines.push('')
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
    lines.push(`SOLVER  glyph solves: ${times.length}; mean ${fmt(mean(times), 1)} ms, max ${fmt(Math.max(...times), 1)} ms; mean CG iterations ${fmt(mean(iters), 0)}, max ${Math.max(...iters)}; barrier re-solves ${barrier}; lattice folds total ${folds} — ${Array.from(foldsAt).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    writeFileSync(REPORT, lines.join('\n') + '\n')
    expect(existsSync(REPORT)).toBe(true)
  })
})
