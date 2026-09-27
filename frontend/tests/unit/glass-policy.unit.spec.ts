import { describe, it, expect } from 'vitest'
import { blurAllowed, nodesWithSomethingBehind, sampleWire, countVisible, GLASS_LIMITS, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

const box = (id: string, x: number, y: number, w = 100, h = 100): NodeBox => ({ id, x, y, w, h })

describe('blurAllowed', () => {
  const base = { mode: 'smart' as const, moving: false, zoom: 1, visibleNodes: 5 }
  it('blurs at rest, in view, uncrowded', () => { expect(blurAllowed(base)).toBe(true) })
  it('never blurs while the canvas moves', () => { expect(blurAllowed({ ...base, moving: true })).toBe(false) })
  it('never blurs below the zoom floor', () => { expect(blurAllowed({ ...base, zoom: GLASS_LIMITS.minZoom - 0.01 })).toBe(false) })
  it('blurs exactly at the zoom floor', () => { expect(blurAllowed({ ...base, zoom: GLASS_LIMITS.minZoom })).toBe(true) })
  it('never blurs when crowded', () => { expect(blurAllowed({ ...base, visibleNodes: GLASS_LIMITS.maxVisibleNodes + 1 })).toBe(false) })
  it("'never' is the exit route", () => { expect(blurAllowed({ ...base, mode: 'never' })).toBe(false) })
  it("'always' blurs while moving", () => {
    expect(blurAllowed({ mode: 'always', moving: true, zoom: 1, visibleNodes: 5 })).toBe(true)
  })
  it("'always' still turns off below the zoom floor", () => {
    expect(blurAllowed({ mode: 'always', moving: false, zoom: GLASS_LIMITS.minZoom - 0.01, visibleNodes: 5 })).toBe(false)
  })
  it("'always' ignores the crowding limit", () => {
    expect(blurAllowed({ mode: 'always', moving: false, zoom: 1, visibleNodes: 500 })).toBe(true)
  })
})

describe('nodesWithSomethingBehind', () => {
  it('marks nothing on an empty canvas', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 300, 0)], [])).toEqual(new Set())
  })
  it('marks both nodes when they overlap', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 50, 50)], [])).toEqual(new Set(['a', 'b']))
  })
  it('does not mark nodes that only touch', () => {
    expect(nodesWithSomethingBehind([box('a', 0, 0), box('b', 100, 0)], [])).toEqual(new Set())
  })
  it('marks a node a foreign wire passes behind', () => {
    const nodes = [box('a', 0, 0, 20, 20), box('mid', 200, -50, 100, 200), box('b', 480, 0, 20, 20)]
    const wires: Wire[] = [{ source: 'a', target: 'b', sx: 20, sy: 10, tx: 480, ty: 10 }]
    expect(nodesWithSomethingBehind(nodes, wires)).toEqual(new Set(['mid']))
  })
  it("ignores a wire's own ends at its own nodes", () => {
    const nodes = [box('a', 0, 0), box('b', 300, 0)]
    const wires: Wire[] = [{ source: 'a', target: 'b', sx: 100, sy: 50, tx: 300, ty: 50 }]
    expect(nodesWithSomethingBehind(nodes, wires)).toEqual(new Set())
  })
})

describe('sampleWire', () => {
  it('starts and ends on the ports', () => {
    const pts = sampleWire({ source: 'a', target: 'b', sx: 0, sy: 0, tx: 100, ty: 40 }, 8)
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts.at(-1)).toEqual({ x: 100, y: 40 })
    expect(pts).toHaveLength(9)
  })
})

describe('countVisible', () => {
  it('counts nodes intersecting the screen', () => {
    const nodes = [box('in', 10, 10), box('out', 5000, 5000)]
    expect(countVisible(nodes, { x: 0, y: 0, zoom: 1, width: 800, height: 600 })).toBe(1)
  })
  it('accounts for pan and zoom', () => {
    // screen = graph * zoom + offset → node at graph 1000 appears at 1000*0.5 - 400 = 100
    expect(countVisible([box('n', 1000, 0)], { x: -400, y: 0, zoom: 0.5, width: 800, height: 600 })).toBe(1)
  })
})
