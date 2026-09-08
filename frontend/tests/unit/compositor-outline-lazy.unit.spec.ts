/**
 * THE OUTLINE PATH DATA IS BUILT ONLY WHEN A STROKE ASKS FOR IT.
 *
 * `paintStrokeStack` takes the layer's outline as path data because a `style: 'shapes'`
 * stroke has to flatten it and march marks along it. Nothing else reads it — and a rect or
 * an ellipse used to build that string EAGERLY, at the call site, on every paint of every
 * frame, for the overwhelmingly common layer that has no shapes stroke at all (or no stroke
 * at all). On a live loop that is a round-rect string per rect per frame, thrown away.
 *
 * These assertions count calls into `polygonGeometry`, the module that actually builds the
 * data, so they see the real work rather than a refactor's shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const spies = vi.hoisted(() => ({ rect: 0, ellipse: 0 }))
vi.mock('~/lib/compositor/polygonGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/compositor/polygonGeometry')>()
  return {
    ...actual,
    roundedRectPathData: (...a: Parameters<typeof actual.roundedRectPathData>) => { spies.rect++; return actual.roundedRectPathData(...a) },
    ellipsePathData: (...a: Parameters<typeof actual.ellipsePathData>) => { spies.ellipse++; return actual.ellipsePathData(...a) },
  }
})

const { paintLayerStack, createRectLayer, createEllipseLayer } = await import('~/composables/useCompositorLayers')
type LocalLayer = Parameters<typeof paintLayerStack>[4][number]
const { makeCtx, installScratchDocument } = await import('./_strokeCtx')

installScratchDocument()

// `paintShapeStroke` assembles its marks into a Path2D under DOMMatrix — neither exists in
// the node environment. Stubbed as inert recorders: this file asks WHETHER the outline was
// built, never what was drawn with it (the marks' geometry is `strokeShapes`' own suite, and
// their pixels are the browser suite's).
class FakePath2D { addPath() {} }
class FakeDOMMatrix { constructor(_a?: unknown) {} }

beforeEach(() => {
  spies.rect = 0
  spies.ellipse = 0
  ;(globalThis as Record<string, unknown>).Path2D = FakePath2D
  ;(globalThis as Record<string, unknown>).DOMMatrix = FakeDOMMatrix
})

const paint = (layers: unknown[], W = 200, H = 200) => {
  const { ctx } = makeCtx('main', W, H)
  paintLayerStack(ctx, W, H, layers.map((l, i) => ({ type: 'local' as const, key: `l:${i}`, layer: l as LocalLayer })), layers as LocalLayer[])
}

const shapesStroke = (id: string) => ({ id, paint: '#fff', width: 0, distance: 0, style: 'shapes', shapes: { shapeId: 'badge', size: 0.1, spacing: 0.05 } })

describe('outlinePathData is lazy', () => {
  it('is NOT built for a rect or an ellipse with an ordinary band stroke', () => {
    paint([
      createRectLayer({ x: 0.3, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: '#f00', strokeWidth: 0.02 }),
      createEllipseLayer({ x: 0.7, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: '#f00', strokeWidth: 0.02 }),
    ])
    expect(spies).toEqual({ rect: 0, ellipse: 0 })
  })

  it('is NOT built for a rect with no stroke at all', () => {
    paint([createRectLayer({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0 })])
    expect(spies.rect).toBe(0)
  })

  it('IS built when a shapes stroke asks for it — the lazy read still feeds the painter', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    rect.strokes = [shapesStroke('a')]
    paint([rect])
    expect(spies.rect).toBe(1)
  })

  it('is built ONCE for a stack of several shapes strokes — memoized, not per entry', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    rect.strokes = [shapesStroke('a'), shapesStroke('b'), shapesStroke('c')]
    paint([rect])
    expect(spies.rect).toBe(1)
  })

  it('an ellipse takes the same path', () => {
    const el = createEllipseLayer({ x: 0.5, y: 0.5, w: 0.3, h: 0.3, fill: '#fff', stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    el.strokes = [shapesStroke('a'), shapesStroke('b')]
    paint([el])
    expect(spies.ellipse).toBe(1)
  })
})
