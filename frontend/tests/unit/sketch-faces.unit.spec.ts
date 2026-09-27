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

describe('faces — fix round 1 (tangents with solver residuals, cache keys, nesting, bridges, outlines)', () => {
  const RES = [1e-8, -1e-8, 1e-6, -1e-6]
  for (const s of [1, 100]) {
    for (const r of RES) {
      it(`a circle tangent inside a D, centre off by ${r}·${s}: three faces, exact areas`, () => {
        const e = doc()
        const p = addPoint(e, -2 * s, 0), q = addPoint(e, 2 * s, 0)
        addPath(e, [p, q], [{ kind: 'arc', center: addPoint(e, 0, 0), sweep: 0 }])
        addLine(e, p, q)
        addCircle(e, addPoint(e, 0, s + r * s), s)
        const fs = findFaces(e)
        expect(fs.faces).toHaveLength(3)
        expect(fs.faces.reduce((a, f) => a + f.area, 0) / (s * s)).toBeCloseTo(2 * Math.PI, 4)
        expect(fs.faces[faceAt(fs, { x: 0, y: s })!]!.area / (s * s)).toBeCloseTo(Math.PI, 4)
      })
      it(`a circle inscribed in a square, radius off by ${r}·${s}: five faces`, () => {
        const d = doc(); square(d, -s, -s, 2 * s); addCircle(d, addPoint(d, 0, 0), s + r * s)
        const fs = findFaces(d)
        expect(fs.faces).toHaveLength(5)
        expect(fs.faces.reduce((a, f) => a + f.area, 0) / (s * s)).toBeCloseTo(4, 4)
        expect(fs.faces[faceAt(fs, { x: 0, y: 0 })!]!.area / (s * s)).toBeCloseTo(Math.PI, 4)
        const corner = fs.faces[faceAt(fs, { x: 0.95 * s, y: 0.95 * s })!]!.area / (s * s)
        expect(corner).toBeCloseTo((4 - Math.PI) / 4, 4)
      })
      it(`two circles touching outside and a box round them, off by ${r}·${s}: eight faces`, () => {
        const d = doc()
        const ids = [[-2 * s, -s], [2 * s, -s], [2 * s, s], [-2 * s, s]].map(([x, y]) => addPoint(d, x!, y!))
        addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
        addCircle(d, addPoint(d, -s, 0), s)
        addCircle(d, addPoint(d, s + r * s, 0), s)
        const fs = findFaces(d)
        expect(fs.faces).toHaveLength(8)
        expect(fs.faces.reduce((a, f) => a + f.area, 0) / (s * s)).toBeCloseTo(8, 4)
        expect(fs.faces[faceAt(fs, { x: -s, y: 0 })!]!.area / (s * s)).toBeCloseTo(Math.PI, 4)
      })
      it(`a circle tangent inside a bigger one, off by ${r}·${s}: a disc and a crescent`, () => {
        const d = doc(); addCircle(d, addPoint(d, 0, 0), 2 * s); addCircle(d, addPoint(d, s + r * s, 0), s)
        const fs = findFaces(d)
        expect(fs.faces).toHaveLength(2)
        expect(fs.faces[faceAt(fs, { x: -s, y: 0 })!]!.area / (s * s)).toBeCloseTo(3 * Math.PI, 4)
        expect(fs.faces[faceAt(fs, { x: s, y: 0 })!]!.area / (s * s)).toBeCloseTo(Math.PI, 4)
      })
    }
  }
  it('a rotated or mirrored drawing never hits the cache of the original', () => {
    const d = doc(); square(d, 0, 0, 4)
    const a = facesFor(d)
    const rot = JSON.parse(JSON.stringify(d)) as SketchDoc
    for (const e of rot.entities) if (e.kind === 'point') { e.x = -e.x; e.y = -e.y }
    expect(geometryKey(rot)).not.toBe(geometryKey(d))
    const b = facesFor(rot)
    expect(b).not.toBe(a)
    expect(faceAt(b, { x: -1, y: -1 })).toBe(0)
    const mir = JSON.parse(JSON.stringify(d)) as SketchDoc
    for (const e of mir.entities) if (e.kind === 'point') e.x = -e.x
    expect(geometryKey(mir)).not.toBe(geometryKey(d))
    expect(faceAt(facesFor(mir), { x: -1, y: 1 })).toBe(0)
  })
  it('three drawings nested: each face has exactly one hole, the one directly inside it', () => {
    const d = doc(); square(d, 0, 0, 10); square(d, 0.5, 0.5, 9); addCircle(d, addPoint(d, 5, 5), 1)
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(3)
    const outer = fs.faces[faceAt(fs, { x: 0.2, y: 0.2 })!]!, mid = fs.faces[faceAt(fs, { x: 1, y: 1 })!]!, disc = fs.faces[faceAt(fs, { x: 5, y: 5 })!]!
    expect(outer.holes).toHaveLength(1)
    expect(mid.holes).toHaveLength(1)
    expect(disc.holes).toHaveLength(0)
    expect(outer.area).toBeCloseTo(19, 9)
    expect(mid.area).toBeCloseTo(81 - Math.PI, 9)
    expect(disc.area).toBeCloseTo(Math.PI, 9)
  })
  it('a lone arc nearly closed into a C bridges across its own gap', () => {
    const d = doc()
    const s = addPoint(d, Math.cos(0.025), Math.sin(0.025)), e = addPoint(d, Math.cos(-0.025), Math.sin(-0.025))
    addPath(d, [s, e], [{ kind: 'arc', center: addPoint(d, 0, 0), sweep: 1 }])
    expect(findFaces(d).faces).toHaveLength(0)
    const fs = findFaces(d, { gap: 0.2 })
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(Math.PI, 2)
  })
  it('a bridge never crosses a piece', () => {
    const d = doc()
    addLine(d, addPoint(d, -5, 0), addPoint(d, 0, 0))
    addLine(d, addPoint(d, 0.15, 0), addPoint(d, 5, 0))
    addLine(d, addPoint(d, 0.075, -1), addPoint(d, 0.075, 1))
    const fs = findFaces(d, { gap: 0.2 })
    expect(fs.bridges.length).toBeGreaterThan(0)
    for (const b of fs.bridges) expect(Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y)).toBeLessThan(0.1)
  })
  it('outlines land on the drawing’s own points, free of trig noise', () => {
    const d = doc(); addCircle(d, addPoint(d, 0, 0), 2)
    expect(facesD(findFaces(d), [0])).toBe('M 2 0 A 2 2 0 0 1 -2 0 A 2 2 0 0 1 2 0 Z')
    const e = doc()
    const a = addPoint(e, 0, 0), b = addPoint(e, 4, 0)
    addPath(e, [a, b], [{ kind: 'arc', center: addPoint(e, 2, -1), sweep: 1 }, { kind: 'arc', center: addPoint(e, 2, 1), sweep: 1 }], true)
    const out = facesD(findFaces(e), [0])
    expect(out).not.toMatch(/e-/)
    expect(out).toMatch(/^M (0 0|4 0) /)
  })
  it('the gappy flower drawn round its square fills petal by petal', () => {
    const d = doc(); gappyFlower(d); square(d, 6, 2, 6)
    // unbridged, only the petals whose overshooting end crosses the next arc close
    expect(findFaces(d).faces.length).toBeLessThan(5)
    const fs = findFaces(d, { gap: 6 / 34 })
    expect(fs.faces).toHaveLength(5)
    expect(fs.faces[faceAt(fs, { x: 9, y: 5 })!]!.area).toBeCloseTo(36, 3)   // the fourth petal's end pokes a sliver into the square
    const petals = [{ x: 9, y: 0.5 }, { x: 13.5, y: 5 }, { x: 9, y: 9.5 }, { x: 4.5, y: 5 }].map(p => faceAt(fs, p))
    expect(new Set(petals).size).toBe(4)
    for (const f of petals) expect(fs.faces[f!]!.area).toBeGreaterThan(12)
  })
  it('a circle crossed once is one disc; the line through it is left out of its outline', () => {
    const d = doc(); addCircle(d, addPoint(d, 0, 0), 2); addLine(d, addPoint(d, 0.5, 0.3), addPoint(d, 4, 0.3))
    const fs = findFaces(d)
    expect(fs.faces).toHaveLength(1)
    expect(fs.faces[0]!.area).toBeCloseTo(4 * Math.PI, 9)
    const out = facesD(fs, [0])
    expect((out.match(/ A /g) ?? []).length).toBe(2)
    expect(out).not.toMatch(/ L /)
  })
  it('a line and an arc leaving a point in the same direction bound the area between them', () => {
    for (const flip of [1, -1]) {
      const d = doc()
      const o = addPoint(d, 0, 0), x = addPoint(d, 2, 0), top = addPoint(d, 2, 2 * flip)
      addLine(d, o, x); addLine(d, x, top)
      addPath(d, [o, top], [{ kind: 'arc', center: addPoint(d, 0, 2 * flip), sweep: flip === 1 ? 1 : 0 }])
      const fs = findFaces(d)
      expect(fs.faces).toHaveLength(1)
      expect(fs.faces[0]!.area).toBeCloseTo(4 - Math.PI, 9)
      expect(faceAt(fs, { x: 1.8, y: 0.2 * flip })).toBe(0)
    }
  })
})

describe('faces — fix round 2 (a piece ending at a tangent touch)', () => {
  // tangency is second-order in the slide: a solve that leaves 1e-8 between a
  // line and a circle can leave the line's END ~1e-4 along from the true touch
  /** Two circles and the two lines of a belt round them; the lines' ends sit on
   *  the circles, slid `sl` (radians) along from the true touch points. */
  function belt(sc: number, sl: number): SketchDoc {
    const d = doc()
    addCircle(d, addPoint(d, 0, 0), sc); addCircle(d, addPoint(d, 5 * sc, 0), sc)
    for (const up of [1, -1]) addLine(d, addPoint(d, sc * Math.sin(sl), up * sc * Math.cos(sl)), addPoint(d, sc * (5 + Math.sin(sl)), up * sc * Math.cos(sl)))
    return d
  }
  /** A circle and a line ending on it at the touch, closed by two lines. */
  function dShape(sc: number, sl: number): SketchDoc {
    const d = doc()
    addCircle(d, addPoint(d, 0, 0), sc)
    const p = addPoint(d, sc * Math.sin(sl), sc * Math.cos(sl)), q = addPoint(d, 3 * sc, sc * Math.cos(sl))
    const r = addPoint(d, 3 * sc, 0), e = addPoint(d, sc, 0)
    addLine(d, p, q); addLine(d, q, r); addLine(d, r, e)
    return d
  }
  /** A circle and an arc touching it from outside, the arc ENDING at the touch
   *  (slid `sl` along its own circle), closed by three lines. */
  function arcShape(sc: number, sl: number): SketchDoc {
    const d = doc()
    addCircle(d, addPoint(d, 0, 0), sc)
    const p = addPoint(d, sc * Math.sin(sl), sc * (2 - Math.cos(sl))), a = addPoint(d, sc, 2 * sc)
    addPath(d, [p, a], [{ kind: 'arc', center: addPoint(d, 0, 2 * sc), sweep: 1 }])
    const b = addPoint(d, 2 * sc, 2 * sc), c = addPoint(d, 2 * sc, 0), e = addPoint(d, sc, 0)
    addLine(d, a, b); addLine(d, b, c); addLine(d, c, e)
    return d
  }
  it('lines tangent to two circles and running a hair past the touches: two discs and the belt', () => {
    for (const sc of [1, 100]) for (const o of [1e-4, 1e-3]) {
      const d = doc()
      addCircle(d, addPoint(d, 0, 0), sc); addCircle(d, addPoint(d, 5 * sc, 0), sc)
      for (const up of [1, -1]) addLine(d, addPoint(d, -o * sc, up * sc), addPoint(d, (5 + o) * sc, up * sc))
      const fs = findFaces(d)
      expect(fs.faces).toHaveLength(3)
      expect(fs.faces[faceAt(fs, { x: 2.5 * sc, y: 0 })!]!.area / (sc * sc)).toBeCloseTo(10 - Math.PI, 6)
    }
  })
  const SLIDES = [1e-5, -1e-5, 1e-4, -1e-4]
  for (const sc of [1, 100]) {
    // slid further than the weld tolerance: the pieces overlap by a hair but
    // cross at two points too far apart to be one touch — two real crossings
    for (const sl of [1e-3, -1e-3]) {
      it(`a belt and a D slid ${sl} (past the weld tolerance, scale ${sc}) keep their faces`, () => {
        const fs = findFaces(belt(sc, sl))
        expect(fs.faces).toHaveLength(3)
        expect(fs.faces[faceAt(fs, { x: 2.5 * sc, y: 0 })!]!.area / (sc * sc)).toBeCloseTo(10 - Math.PI, 3)
        expect(findFaces(dShape(sc, sl)).faces).toHaveLength(2)
        expect(findFaces(arcShape(sc, sl)).faces).toHaveLength(2)
      })
    }
    const arcRef = findFaces(arcShape(sc, 0))
    for (const sl of SLIDES) {
      it(`a belt whose ends are slid ${sl} along the circles (scale ${sc}): two discs and the belt`, () => {
        const fs = findFaces(belt(sc, sl))
        expect(fs.faces).toHaveLength(3)
        expect(fs.faces[faceAt(fs, { x: 2.5 * sc, y: 0 })!]!.area / (sc * sc)).toBeCloseTo(10 - Math.PI, 4)
        expect(fs.faces[faceAt(fs, { x: 0, y: 0 })!]!.area / (sc * sc)).toBeCloseTo(Math.PI, 6)
      })
      it(`a D whose top line ends slid ${sl} along the circle (scale ${sc}): the disc and the D`, () => {
        const fs = findFaces(dShape(sc, sl))
        expect(fs.faces).toHaveLength(2)
        expect(fs.faces[faceAt(fs, { x: 2 * sc, y: 0.5 * sc })!]!.area / (sc * sc)).toBeCloseTo(3 - Math.PI / 4, 4)
      })
      it(`an arc ending at its touch on a circle, slid ${sl} (scale ${sc}): the disc and the area beside them`, () => {
        const fs = findFaces(arcShape(sc, sl))
        expect(fs.faces).toHaveLength(2)
        expect(arcRef.faces).toHaveLength(2)
        const probe = { x: 1.5 * sc, y: 1 * sc }
        expect(fs.faces[faceAt(fs, probe)!]!.area / (sc * sc)).toBeCloseTo(arcRef.faces[faceAt(arcRef, probe)!]!.area / (sc * sc), 4)
        expect(fs.faces[faceAt(fs, { x: 0, y: 0 })!]!.area / (sc * sc)).toBeCloseTo(Math.PI, 6)
      })
    }
  }
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
