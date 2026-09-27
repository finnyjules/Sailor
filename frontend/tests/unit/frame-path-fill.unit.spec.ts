// tests/unit/frame-path-fill.unit.spec.ts
// Pen stage 7, the Frame's painter: the canvas calls a path layer makes,
// recorded on a stand-in context (node has no canvas). The snapshot was
// written BEFORE drawPath learnt fillD — a layer without fillD must keep
// making exactly those calls. A layer with fillD fills it (non-zero) and
// strokes d; the SVG export and the shape swap treat fillD the same way.
import { describe, it, expect } from 'vitest'
class FakePath2D { constructor(public d: string) {} }
;(globalThis as any).Path2D = FakePath2D
const { drawLocalLayer, createPathLayer } = await import('~/composables/useCompositorLayers')

function record(layer: any): string[] {
  const log: string[] = []
  const fmt = (v: unknown) => (v instanceof FakePath2D ? `Path(${v.d})` : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const ctx: any = new Proxy({ canvas: { width: 1000, height: 800 } }, {
    get(t, k) {
      if (k in t) return (t as any)[k]
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) => { log.push(`${String(k)}(${args.map(fmt).join(', ')})`) }
    },
    set(t, k, v) { log.push(`${String(k)} = ${fmt(v)}`); (t as any)[k] = v; return true },
  })
  drawLocalLayer(ctx, layer, 1000, 800)
  return log
}
const TRI = 'M 0 0 L 0.1 0 L 0.05 0.1 Z'
const OPEN = 'M 0 0 L 0.1 0 M 0.02 -0.02 L 0.05 0.1'
const CASES: Record<string, any> = {
  'closed drawing, fill only': createPathLayer({ id: 'a', d: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '', strokeWidth: 0 } as any),
  'open drawing, stroke only': createPathLayer({ id: 'b', d: OPEN, sketch: { entities: [], constraints: [] }, fill: 'none', stroke: '#3b82f6', strokeWidth: 0.004 } as any),
  'library path, even-odd, fill and stroke': createPathLayer({ id: 'c', d: TRI + ' M 0.03 0.02 L 0.07 0.02 L 0.05 0.06 Z', fillRule: 'evenodd', fill: '#111111', stroke: '#eeeeee', strokeWidth: 0.002, rotation: 12, scale: 1.5 } as any),
}
describe('a Frame path layer paints exactly as before stage 7 when it has no fillD', () => {
  for (const [name, layer] of Object.entries(CASES)) it(name, () => { expect(record(layer)).toMatchSnapshot() })
})
describe('a layer with fillD fills it and strokes d', () => {
  it('fills fillD non-zero, strokes d', () => {
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fillRule: 'evenodd', fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004 } as any)
    const log = record(l)
    expect(log).toContain(`fill(Path(${TRI}), nonzero)`)
    expect(log).toContain(`stroke(Path(${OPEN}))`)
    expect(log.some(x => x.startsWith('fill(Path(' + OPEN))).toBe(false)
  })
})
describe('the other writers of a path layer', () => {
  it('the SVG export fills fillD non-zero and keeps d for the outline', async () => {
    const { pathLayersToSvgDoc } = await import('~/composables/useVectorSvg')
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004 } as any)
    const { svg } = pathLayersToSvgDoc([l as any], 1)
    expect(svg).toContain(`<path d="${TRI}" fill="#3b82f6" fill-rule="nonzero"/>`)
    expect(svg).toContain(`d="${OPEN}"`)
    const plain = createPathLayer({ id: 'g', d: TRI, fillRule: 'evenodd', fill: '#3b82f6' } as any)
    expect(pathLayersToSvgDoc([plain as any], 1).svg).toContain(`<path d="${TRI}" fill="#3b82f6" fill-rule="evenodd"/>`)
  })
  it('swapping in a library shape drops fillD with the sketch', async () => {
    const { swapShapeLayer } = await import('~/lib/shapes/pathLayer')
    const { SHAPES } = await import('~/lib/shapes/catalog')
    const l = createPathLayer({ id: 'f', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] } } as any)
    const out = swapShapeLayer(l as any, SHAPES[0]!)
    expect(out.sketch).toBeUndefined()
    expect(out.fillD).toBeUndefined()
  })
})
describe('geometry effects and fillD', () => {
  it('a geometry effect runs on the filled areas too (offset), and the stroke is the offset d', async () => {
    const { applyGeometry } = await import('~/lib/compositor/geometryEffects')
    const eff = { id: 'e1', type: 'offset', distance: 0.01, visible: true }
    const l = createPathLayer({ id: 'g', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004, effects: [eff] } as any)
    const log = record(l)
    const gFill = applyGeometry(TRI, [eff] as any, { W: 1 })
    const gD = applyGeometry(OPEN, [eff] as any, { W: 1 })
    expect(gFill).not.toBe(TRI)
    expect(log).toContain(`fill(Path(${gFill}), nonzero)`)
    expect(log.some(x => x.startsWith(`stroke(Path(${gD}`))).toBe(true)
    expect(log.some(x => x.startsWith(`fill(Path(${TRI})`))).toBe(false)
  })
})
describe('fix round 1: a filled layer never fills d', () => {
  it('fillD present but empty: nothing is filled, d is still stroked', () => {
    const l = createPathLayer({ id: 'e', d: OPEN, fillD: '', sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004 } as any)
    const log = record(l)
    expect(log.some(x => x.startsWith('fill('))).toBe(false)
    expect(log).toContain(`stroke(Path(${OPEN}))`)
  })
  it('a geometry effect that empties fillD: nothing is filled (the effect’s d is still stroked)', () => {
    // trim drops a zero-length ring: 'M 0 0 Z' → '' while the open lines survive
    const eff = { id: 'e1', type: 'trim', start: 0, end: 0.999, offset: 0, visible: true }
    const l = createPathLayer({ id: 'e2', d: OPEN, fillD: 'M 0 0 Z', sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004, effects: [eff] } as any)
    const log = record(l)
    expect(log.some(x => x.startsWith('fill('))).toBe(false)
    expect(log.some(x => x.startsWith('stroke(Path('))).toBe(true)
  })
  it('a long shadow casts from the filled areas when there are any', async () => {
    const { longShadowBody } = await import('~/lib/compositor/geometryEffects')
    const eff = { id: 's1', type: 'long_shadow', angle: 45, length: 0.05, color: 'rgba(0,0,0,0.35)', visible: true }
    const l = createPathLayer({ id: 's', d: OPEN, fillD: TRI, sketch: { entities: [], constraints: [] }, fill: '#3b82f6', stroke: '#111111', strokeWidth: 0.004, effects: [eff] } as any)
    const log = record(l)
    const fromFill = longShadowBody(TRI, Math.PI / 4, 0.05)
    const fromD = longShadowBody(OPEN, Math.PI / 4, 0.05)
    expect(fromFill).not.toBe(fromD)
    expect(log).toContain(`fill(Path(${fromFill}))`)
  })
})
