import { describe, it, expect } from 'vitest'
import { posterLayerViews, buildFrameContext } from '~/lib/frame/patterns/frameContext'

const stubMeasure = (t: string) => t.length * 60

const props = {
  sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5 },
    { id: 'd', kind: 'text', text: '12–14 October 2026', fontSize: 0.03, x: 0.5, y: 0.9 },
    { id: 'b', kind: 'brush', x: 0.5, y: 0.5 },                 // dropped
    { id: 'r', kind: 'path', x: 0.5, y: 0.5, shapeId: 'sun-rays' },  // → shape
    { id: 'i', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5 },
  ],
}

describe('posterLayerViews', () => {
  it('maps text/image/shape and drops non-poster kinds', () => {
    const v = posterLayerViews(props)
    expect(v.map(x => x.id)).toEqual(['t', 'd', 'r', 'i'])   // brush dropped
    expect(v.find(x => x.id === 'r')).toMatchObject({ kind: 'shape', shapeId: 'sun-rays' })
    expect(v.find(x => x.id === 'i')).toMatchObject({ kind: 'image' })
  })
  it('defaults to empty on a bare node', () => {
    expect(posterLayerViews(undefined)).toEqual([])
    expect(posterLayerViews({})).toEqual([])
  })
  it('treats a wired layer as an image element (a connected photo the engine can arrange)', () => {
    const props = { sailor_localLayers: [
      { id: 't', kind: 'text', text: 'HELLO', fontSize: 0.2 },
      { id: 'w', kind: 'wired', slot: 0, w: 0.5, lastAspect: 1 },
    ] }
    const v = posterLayerViews(props)
    expect(v).toContainEqual({ id: 'w', kind: 'image' })
  })
})

describe('buildFrameContext', () => {
  it('assembles a context with inferred elements and no grid when off', () => {
    // inferElements only reaches date-detection once there are 3+ text layers
    // (with exactly 2, the sole non-title text is unconditionally the caption) —
    // add a smaller, non-date caption line so 'd' lands in the date branch.
    const withCaption = {
      ...props,
      sailor_localLayers: [...props.sailor_localLayers, { id: 'c', kind: 'text', text: 'SUBTITLE', fontSize: 0.01, x: 0.5, y: 0.95 }],
    }
    const ctx = buildFrameContext(withCaption, 800, 1000, stubMeasure)
    expect(ctx.frame).toEqual({ w: 800, h: 1000 })
    expect(ctx.grid).toBeNull()                 // default grid mode is 'off'
    expect(ctx.elements.title?.id).toBe('t')
    expect(ctx.elements.date?.id).toBe('d')
    expect(ctx.measure('AB')).toBe(120)
    expect(typeof ctx.seed).toBe('number')
  })
  it('resolves a grid when the frame declares one', () => {
    const withGrid = { ...props, sailor_localGrid: { mode: 'explicit', columns: 4, rows: 4, margin: 0.05 } }
    const ctx = buildFrameContext(withGrid, 800, 1000, stubMeasure)
    expect(ctx.grid).not.toBeNull()
    expect(ctx.grid!.xs.length).toBeGreaterThan(0)
    expect(ctx.margin).toBeCloseTo(0.05, 5)
  })
  it('clamps an extreme margin like resolveGrid does', () => {
    const withMargin = { ...props, sailor_localGrid: { mode: 'off', margin: 0.6 } }
    const ctx = buildFrameContext(withMargin, 800, 1000, stubMeasure)
    expect(ctx.margin).toBe(0.45)
  })
})
