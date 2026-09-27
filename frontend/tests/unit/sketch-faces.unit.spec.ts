// tests/unit/sketch-faces.unit.spec.ts
// Pen stage 7: the areas a drawing encloses — lines, arcs and circles split
// where they cross or touch, the planar graph walked face by face with exact
// arc geometry, holes nested, guides and Bézier pieces left out, gaps
// bridged, true-arc outlines out — and fast enough on one connected drawing
// and a symmetric grid.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { findFaces, faceAt, facesD, facesFor, geometryKey } from '~/lib/sketch/faces'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number): string {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
/** The owner's trimmed flower from stage 5: four petal arcs round a square, each
 *  a separate open piece ending 3.2 px (at 34 px per unit) short of the next. */
function gappyFlower(d: SketchDoc) {
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1! + 0.08, ey = y1! + 0.05
    const s = addPoint(d, x0!, y0!), e = addPoint(d, ex, ey), c = addPoint(d, (x0! + ex) / 2, (y0! + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

describe('faces', () => {
  it('a closed square is one face, with a straight outline', () => {
    const d = doc(); square(d, 0, 0, 4)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(16, 9)
    expect(faceAt(fs, { x: 1, y: 1 })).toBe(0)
    expect(faceAt(fs, { x: 5, y: 1 })).toBeNull()
    expect(facesD(fs, [0])).toBe('M 0 0 L 4 0 L 4 4 L 0 4 L 0 0 Z')
  })
  it('two crossing circles make three faces, measured exactly; the lens is two true arcs', () => {
    const d = doc(); addCircle(d, addPoint(d, 0, 0), 2); addCircle(d, addPoint(d, 2, 0), 2)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(3)
    const lens = 2 * 4 * Math.acos(2 / 4) - Math.sqrt(16 - 4)
    expect(fs.faces.reduce((s, f) => s + f.area, 0)).toBeCloseTo(2 * Math.PI * 4 - lens, 9)
    const mid = faceAt(fs, { x: 1, y: 0 })!
    expect(fs.faces[mid]!.area).toBeCloseTo(lens, 9)
    const out = facesD(fs, [mid])
    expect((out.match(/ A /g) ?? []).length).toBe(2)
    expect(out.endsWith(' Z')).toBe(true)
  })
  it('a whole circle is one face of area πr², written as two half arcs', () => {
    const d = doc(); addCircle(d, addPoint(d, 1, 1), 3)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(9 * Math.PI, 9)
    expect((facesD(fs, [0]).match(/ A /g) ?? []).length).toBe(2)
  })
  it('a circle inside a square is a hole of the square’s face, and a face of its own', () => {
    const d = doc(); square(d, 0, 0, 10); addCircle(d, addPoint(d, 5, 5), 2)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(2)
    const ring = faceAt(fs, { x: 1, y: 1 })!, disc = faceAt(fs, { x: 5, y: 5 })!
    expect(ring).not.toBe(disc)
    expect(fs.faces[ring]!.area).toBeCloseTo(100 - 4 * Math.PI, 9)
    expect(fs.faces[ring]!.holes).toHaveLength(1)
    // the ring's outline carries the hole (a second subpath)
    expect((facesD(fs, [ring]).match(/M /g) ?? []).length).toBe(2)
  })
  it('a 3 × 3 grid of open lines makes four cells', () => {
    const d = doc()
    for (let i = 0; i < 3; i++) {
      addLine(d, addPoint(d, -1, i * 2), addPoint(d, 5, i * 2))
      addLine(d, addPoint(d, i * 2, -1), addPoint(d, i * 2, 5))
    }
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(4)
    for (const f of fs.faces) expect(f.area).toBeCloseTo(4, 9)
  })
  it('guides bound nothing; Bézier pieces bound nothing', () => {
    const d = doc(); const id = square(d, 0, 0, 4)
    ;(d.entities.find(e => e.id === id) as { construction?: boolean }).construction = true
    expect(findFaces(d).faces).toHaveLength(0)
    const e = doc()
    const a = addPoint(e, 0, 0), b = addPoint(e, 4, 0), c = addPoint(e, 2, 3)
    addPath(e, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'cubic', h1: null, h2: null }], true)
    expect(findFaces(e).faces).toHaveLength(0)
  })
  it('three open lines crossing make a triangle; the ends poking out are left out of its outline', () => {
    const d = doc()
    addLine(d, addPoint(d, -1, 0), addPoint(d, 5, 0))
    addLine(d, addPoint(d, 0, -1), addPoint(d, 2.5, 5))
    addLine(d, addPoint(d, 4, -1), addPoint(d, 1.5, 5))
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect((facesD(fs, [0]).match(/ L /g) ?? []).length).toBe(3)
  })
  it('a lens of two arcs; a circle touching a D shape tangentially from inside splits it in three', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    addPath(d, [a, b], [{ kind: 'arc', center: addPoint(d, 2, -1), sweep: 1 }, { kind: 'arc', center: addPoint(d, 2, 1), sweep: 1 }], true)
    expect(findFaces(d).faces).toHaveLength(1)
    const e = doc()
    const p = addPoint(e, -2, 0), q = addPoint(e, 2, 0)
    addPath(e, [p, q], [{ kind: 'arc', center: addPoint(e, 0, 0), sweep: 0 }])
    addLine(e, p, q)
    addCircle(e, addPoint(e, 0, 1), 1)   // touches the line at (0,0) and the arc at (0,2)
    const fs = findFaces(e)
    expect(fs.faces).toHaveLength(3)
    expect(fs.faces.reduce((s, f) => s + f.area, 0)).toBeCloseTo(2 * Math.PI, 6)
  })
  it('a nearly-closed drawing is an area only when its gaps are bridged', () => {
    const d = doc(); gappyFlower(d)
    expect(findFaces(d).faces).toHaveLength(0)
    const fs = findFaces(d, { gap: 6 / 34 })
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[faceAt(fs, { x: 9, y: 5 })!]!.area).toBeGreaterThan(90)
    expect(fs.bridges.length).toBeGreaterThanOrEqual(4)
    expect(fs.dangling).toHaveLength(0)
    const tight = findFaces(d, { gap: 1 / 34 })
    expect(tight.faces).toHaveLength(0)
    expect(tight.dangling.length).toBeGreaterThanOrEqual(8)
  })
  it('faces are cached by geometry: an unchanged drawing is a lookup, a moved point is not', () => {
    const d = doc(); square(d, 0, 0, 4)
    const a = facesFor(d)
    expect(facesFor(JSON.parse(JSON.stringify(d)))).toBe(a)
    expect(facesFor(d, 0.1)).not.toBe(a)
    const k = geometryKey(d)
    ;(d.entities[0] as { x: number }).x += 1e-9
    expect(geometryKey(d)).not.toBe(k)
    expect(facesFor(d)).not.toBe(a)
  })
})

describe('faces — speed (one connected drawing, a symmetric grid)', () => {
  it('161 pieces round a ring and a 21 × 21 grid stay well inside a frame', () => {
    // 64 two-arc petals round a circle, a spoke to every other one: one connected drawing
    const d = doc()
    const O = addPoint(d, 0, 0); addCircle(d, O, 10)
    for (let k = 0; k < 64; k++) {
      const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
      const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
      addPath(d, [s, e], [
        { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
        { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
      ], true)
      if (k % 2 === 0) addLine(d, O, s)
    }
    const pieces = d.entities.reduce((n, e) => n + (e.kind === 'path' ? e.segments.length : e.kind === 'point' ? 0 : 1), 0)
    expect(pieces).toBe(161)
    findFaces(d)   // warm up
    let t = performance.now()
    const fs = findFaces(d)
    const cold = performance.now() - t
    expect(fs.faces.length).toBeGreaterThan(200)
    expect(cold).toBeLessThan(40)
    facesFor(d)
    t = performance.now(); for (let i = 0; i < 10; i++) facesFor(d); const hit = (performance.now() - t) / 10
    expect(hit).toBeLessThan(1)
    t = performance.now(); for (let i = 0; i < 100; i++) faceAt(fs, { x: 3, y: 1 }); const probe = (performance.now() - t) / 100
    expect(probe).toBeLessThan(0.05)

    const g = doc()
    for (let i = 0; i <= 20; i++) {
      addLine(g, addPoint(g, -1, i), addPoint(g, 21, i))
      addLine(g, addPoint(g, i, -1), addPoint(g, i, 21))
    }
    findFaces(g)
    t = performance.now()
    const gs = findFaces(g)
    expect(performance.now() - t).toBeLessThan(40)
    expect(gs.faces).toHaveLength(400)
  })
})
