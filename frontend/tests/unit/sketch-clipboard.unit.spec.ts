// tests/unit/sketch-clipboard.unit.spec.ts
// Pen stage 6, Copy / Paste: the pieces with the rules among them go out as
// a drawing of their own, and come back in with fresh ids, moved, every ref
// re-pointed — so no rule ever ties a pasted piece to the original.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { extractPieces, insertPieces, piecesCentre, hasClosedPieces, scalePieces } from '~/lib/sketch/clipboard'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('extractPieces', () => {
  it('takes the pieces, their points and only the rules among them — as copies', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), far = addPoint(d, 9, 9)
    const l = addLine(d, a, b)
    const h = addConstraint(d, 'horizontal', [a, b])
    addConstraint(d, 'distance', [b, far], 3)
    const clip = extractPieces(d, [l], [])
    expect(clip.entities.map(e => e.id).sort()).toEqual([a, b, l].sort())
    expect(clip.constraints.map(c => c.id)).toEqual([h])
    P(clip, a).x = 99
    expect(P(d, a).x).toBe(0)
  })
  it('an Option-picked arc becomes a one-piece open path that keeps its equal-ends rule', () => {
    const d = empty()
    const s = addPoint(d, 0, 0), e = addPoint(d, 2, 2), m = addPoint(d, 4, 2), c = addPoint(d, 2, 0)
    const path = addPath(d, [s, e, m], [{ kind: 'arc', center: c, sweep: 1 }, { kind: 'line' }])
    const clip = extractPieces(d, [], [{ pathId: path, segIndex: 0 }])
    const paths = clip.entities.filter(x => x.kind === 'path') as any[]
    expect(paths).toHaveLength(1)
    expect(paths[0].anchors).toEqual([s, e])
    expect(paths[0].segments).toEqual([{ kind: 'arc', center: c, sweep: 1 }])
    expect(paths[0].closed).toBe(false)
    expect(clip.constraints.map(k => k.kind)).toEqual(['equalDist'])
    expect(clip.entities.some(x => x.id === m)).toBe(false)
  })
})

describe('insertPieces', () => {
  it('pastes with fresh ids, moved, rules re-pointed; returns the pasted pieces', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l = addLine(d, a, b)
    addConstraint(d, 'horizontal', [a, b])
    const clip = extractPieces(d, [l], [])
    const before = d.entities.length
    const { top, created } = insertPieces(d, clip, { x: 1, y: -1 })
    expect(d.entities.length).toBe(before + 3)
    expect(created).toHaveLength(3)
    expect(top).toHaveLength(1)
    const nl = P(d, top[0]!)
    expect(nl.kind).toBe('line')
    expect([nl.p1, nl.p2]).not.toContain(a)
    expect(P(d, nl.p1)).toMatchObject({ x: 1, y: -1 })
    expect(P(d, nl.p2)).toMatchObject({ x: 5, y: -1 })
    const hs = d.constraints.filter(c => c.kind === 'horizontal')
    expect(hs).toHaveLength(2)
    expect(hs[1]!.refs).toEqual([nl.p1, nl.p2])
    const ids = [...d.entities.map(e => e.id), ...d.constraints.map(c => c.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('a path keeps its arc centre and its equal-ends rule on the new points', () => {
    const d = empty()
    const s = addPoint(d, 0, 0), e = addPoint(d, 2, 2), c = addPoint(d, 2, 0)
    const path = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    const { top } = insertPieces(d, extractPieces(d, [path], []), { x: 10, y: 0 })
    const np = P(d, top[0]!)
    expect(np.kind).toBe('path')
    expect(np.anchors).not.toContain(s)
    expect(P(d, np.segments[0].center)).toMatchObject({ x: 12, y: 0 })
    const eq = d.constraints.filter(k => k.kind === 'equalDist')
    expect(eq).toHaveLength(2)
    expect(eq[1]!.refs).toEqual([np.segments[0].center, np.anchors[0], np.segments[0].center, np.anchors[1]])
  })
  it('pasting one copy twice makes two copies', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0))
    const clip = extractPieces(d, [l], [])
    insertPieces(d, clip, { x: 1, y: 0 })
    insertPieces(d, clip, { x: 2, y: 0 })
    expect(d.entities.filter(e => e.kind === 'line')).toHaveLength(3)
  })
})

describe('centre and closed pieces', () => {
  it('measures the copy and tells a closed one', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 2))
    expect(piecesCentre(extractPieces(d, [l], []))).toEqual({ x: 2, y: 1 })
    expect(hasClosedPieces(extractPieces(d, [l], []))).toBe(false)
    const circle = addCircle(d, addPoint(d, 5, 5), 1)
    const clip = extractPieces(d, [circle], [])
    expect(piecesCentre(clip)).toEqual({ x: 5, y: 5 })
    expect(hasClosedPieces(clip)).toBe(true)
  })
})

describe('scalePieces', () => {
  it('resizes about the middle; held lengths scale; upside down turns arcs and Repeat turns over', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    addConstraint(d, 'distance', [a, b], 4)
    const c = addCircle(d, addPoint(d, 2, 2), 1)
    addConstraint(d, 'radius', [c], 1)
    const s = addPoint(d, 1, 0), e = addPoint(d, 2, 1), m = addPoint(d, 2, 0)
    addPath(d, [s, e], [{ kind: 'arc', center: m, sweep: 1 }])
    addConstraint(d, 'rotatedFrom', [e, s, m], 90)
    const before = JSON.stringify(d)
    const ctr = piecesCentre(d)
    const out = scalePieces(d, 2, true)
    expect(JSON.stringify(d)).toBe(before)                       // a new drawing
    expect(piecesCentre(out)).toEqual(ctr)                        // about its middle
    expect(P(out, b).x - P(out, a).x).toBeCloseTo(8, 9)
    expect(P(out, a).y).toBeCloseTo(ctr.y + (ctr.y - 0) * 2, 9)  // y turned over
    expect(out.constraints.find(k => k.kind === 'distance')!.value).toBe(8)
    expect(out.constraints.find(k => k.kind === 'radius')!.value).toBe(2)
    expect((out.entities.find(x => x.id === c) as any).r).toBe(2)
    expect((out.entities.find(x => x.kind === 'path') as any).segments[0].sweep).toBe(0)
    expect(out.constraints.find(k => k.kind === 'rotatedFrom')!.value).toBe(-90)
    // not turned over: arcs and turns as they were
    const same = scalePieces(d, 0.5)
    expect((same.entities.find(x => x.kind === 'path') as any).segments[0].sweep).toBe(1)
    expect(same.constraints.find(k => k.kind === 'rotatedFrom')!.value).toBe(90)
  })
})
