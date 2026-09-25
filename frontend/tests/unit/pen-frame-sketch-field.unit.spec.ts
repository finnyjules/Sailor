import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { sketchToLocalD } from '~/lib/compositor/penFrame'
import type { LibraryShape } from '../../shared/shape-library'
import { shapeById } from '../../app/lib/shapes/catalog'
import { createShapeLayer, swapShapeLayer } from '../../app/lib/shapes/pathLayer'
import { segmentsToPathLayer, pathLayerToSegments } from '~/composables/useVectorSvg'
import type { PathLayer } from '~/composables/useCompositorLayers'

const square = (x0: number, y0: number, s: number): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const a = addPoint(d, x0, y0), b = addPoint(d, x0 + s, y0), c = addPoint(d, x0 + s, y0 + s), e = addPoint(d, x0, y0 + s)
  addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

describe('PathLayer.sketch', () => {
  it('swapShapeLayer drops a stale sketch and replaces d with the new shape', () => {
    const sketch = square(0, 0, 30)
    const base: PathLayer = { ...createShapeLayer(tall, { id: 'k' }), sketch }
    const circle = shapeById('circle')!
    const out = swapShapeLayer(base, circle)
    expect(out.sketch).toBeUndefined()
    expect(out.d).not.toBe(base.d)
    expect(out.shapeId).toBe('circle')
  })

  it('segmentsToPathLayer (node-edit rebuild) never carries a sketch', async () => {
    const base = createShapeLayer(tall, { id: 'k' })
    const dims = { w: 680, h: 400 }
    const segs = await pathLayerToSegments(base, dims)
    const rebuilt = await segmentsToPathLayer(segs, base, dims)
    expect(rebuilt).not.toBeNull()
    expect('sketch' in (rebuilt as object)).toBe(false)
  })

  it('a layer with a sketch survives a JSON round trip with the invariant intact', () => {
    const sketch = square(10, 20, 30)
    const layer: PathLayer = { ...createShapeLayer(tall, { id: 'k' }), d: sketchToLocalD(sketch), sketch }
    const copy = JSON.parse(JSON.stringify(layer)) as PathLayer
    expect(copy.sketch).toBeDefined()
    expect(sketchToLocalD(copy.sketch!)).toBe(copy.d)
  })
})
