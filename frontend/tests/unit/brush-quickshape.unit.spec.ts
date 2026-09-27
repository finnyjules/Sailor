import { describe, it, expect } from 'vitest'
import { fitShape, adjustShape, shapePoints, shapeLabel, medianSpeed, timedSamples } from '~/lib/brushTips/quickShape'

let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
const line = Array.from({ length: 50 }, (_, i) => ({ x: 100 + i * 6, y: 200 + rnd() * 4 }))
const arc = Array.from({ length: 50 }, (_, i) => { const a = Math.PI * (0.1 + 0.8 * i / 49); return { x: 300 + Math.cos(a) * 150 + rnd() * 2, y: 400 - Math.sin(a) * 150 + rnd() * 2 } })
const ellipse = Array.from({ length: 80 }, (_, i) => { const a = i / 79 * Math.PI * 2 * 1.02; return { x: 300 + Math.cos(a) * 160 + rnd() * 3, y: 300 + Math.sin(a) * 90 + rnd() * 3 } })
const circle = Array.from({ length: 80 }, (_, i) => { const a = i / 79 * Math.PI * 2 * 1.02; return { x: 300 + Math.cos(a) * 100 + rnd() * 2, y: 300 + Math.sin(a) * 100 + rnd() * 2 } })
const tri = (() => { const V = [{ x: 100, y: 400 }, { x: 250, y: 120 }, { x: 400, y: 400 }, { x: 104, y: 398 }]; const out = []; for (let k = 0; k < 3; k++) for (let i = 0; i < 30; i++) { const a = V[k]!, b = V[k + 1]!; out.push({ x: a.x + (b.x - a.x) * i / 30, y: a.y + (b.y - a.y) * i / 30 }) } out.push(V[3]!); return out })()
const sCurve = Array.from({ length: 80 }, (_, i) => { const t = i / 79; return { x: 100 + t * 300, y: 300 + Math.sin(t * Math.PI * 2) * 60 } })
const blob = Array.from({ length: 140 }, (_, i) => { const a = i / 139 * Math.PI * 2 * 1.02, r = 120 + 30 * Math.cos(3 * a); return { x: 300 + Math.cos(a) * r, y: 300 + Math.sin(a) * r } })
const scribble = Array.from({ length: 60 }, (_, i) => ({ x: 100 + i * 4, y: 200 + Math.sin(i * 0.9) * 40 }))

describe('quickShape', () => {
  it('recognises a wobbly line', () => { const s = fitShape(line)!; expect(s.kind).toBe('line'); expect(shapeLabel(s, false)).toBe('Line') })
  it('recognises an arc', () => { expect(fitShape(arc)!.kind).toBe('arc') })
  it('recognises an ellipse and a circle', () => {
    expect(fitShape(ellipse)!.kind).toBe('ellipse')
    expect(fitShape(circle)!.kind).toBe('circle')
    expect(shapeLabel(fitShape(ellipse)!, true)).toBe('Circle')
  })
  it('recognises a closed triangle as a shape with corners', () => {
    const s = fitShape(tri)!; expect(s.kind).toBe('shape'); expect(shapeLabel(s, false)).toBe('Shape')
  })
  it('a smooth S-curve has no corners, so it stays as drawn', () => { expect(fitShape(sCurve)).toBeNull() })
  it('a smooth blob that is not an ellipse stays as drawn', () => { expect(fitShape(blob)).toBeNull() })
  it('a scribble is a shape or nothing, never a line/arc/ellipse', () => {
    // its zigzag peaks are sharp corners, so it may still snap to a shape
    const s = fitShape(scribble); expect(s === null || s.kind === 'shape').toBe(true)
  })
  it('too short to snap', () => { expect(fitShape([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 1 }, { x: 12, y: 0 }])).toBeNull() })
  it('a line end follows the cursor; shift snaps to 15°', () => {
    const s = fitShape(line)!, end = line.at(-1)!
    const moved = adjustShape(s, end, { x: end.x + 10, y: end.y + 40 }, false)
    const pts = shapePoints(moved, false); expect(pts.at(-1)!.y).toBeGreaterThan(end.y + 30)
    const snapped = shapePoints(adjustShape(s, end, { x: end.x + 10, y: end.y + 7 }, true), true)
    const a = Math.atan2(snapped.at(-1)!.y - snapped[0]!.y, snapped.at(-1)!.x - snapped[0]!.x) / (Math.PI / 12)
    expect(Math.abs(a - Math.round(a))).toBeLessThan(1e-6)
  })
  it('an ellipse resizes around its centre', () => {
    const s = fitShape(ellipse)!, c0 = ellipse.at(-1)!
    const big = shapePoints(adjustShape(s, c0, { x: 300 + (c0.x - 300) * 1.5, y: 300 + (c0.y - 300) * 1.5 }, false), false)
    const r = (P: { x: number; y: number }[]) => Math.max(...P.map(p => Math.hypot(p.x - 300, p.y - 300)))
    expect(r(big) / r(shapePoints(s, false))).toBeGreaterThan(1.4)
  })
  it('shift draws an ellipse as a circle', () => {
    const s = fitShape(ellipse)!
    if (s.kind !== 'ellipse') throw new Error('expected ellipse')
    const P = shapePoints(s, true), d = P.map(p => Math.hypot(p.x - s.cx, p.y - s.cy))
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(6)
  })
  it('shape points are dense and a closed ellipse overlaps its start', () => {
    const P = shapePoints(fitShape(circle)!, false)
    for (let i = 1; i < P.length; i++) expect(Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y)).toBeLessThan(4)
    expect(Math.hypot(P.at(-1)!.x - P[0]!.x, P.at(-1)!.y - P[0]!.y)).toBeLessThan(25)
  })
  it('timing: median speed and even samples', () => {
    const samples = [0, 1, 2, 3, 4].map(i => ({ x: i * 10, y: 0, t: i * 20 }))
    expect(medianSpeed(samples)).toBeCloseTo(0.5)
    const T = timedSamples([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }], 0.5)
    expect(T.map(s => s.t)).toEqual([0, 20, 60])
    expect(medianSpeed([{ x: 0, y: 0, t: 0 }])).toBeGreaterThan(0)
  })
})
