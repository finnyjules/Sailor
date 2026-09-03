import { describe, it, expect, beforeAll } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

/** Path2D stand-in that remembers its path data — node has no canvas. */
class FakePath2D { constructor(public d: string) {} }

/** A recording 2D context: transforms and paints, in order. */
class RecCtx {
  ops: any[] = []
  fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 1; lineJoin = 'miter'
  save() { this.ops.push(['save']) }
  restore() { this.ops.push(['restore']) }
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p.d, this.strokeStyle, this.lineWidth]) }
}

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

beforeAll(() => { (globalThis as any).Path2D = FakePath2D })

describe('shapeAspect', () => {
  it('is box width over height', async () => {
    const { shapeAspect } = await import('../../app/lib/shapes/path2d')
    expect(shapeAspect(tall)).toBe(0.5)
  })
})

describe('drawShape', () => {
  it('fits the ink box into the target, keeps aspect, centres, fills with the shape rule', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 100, h: 100, fill: '#abc' })
    // scale = min(100/20, 100/40) = 2.5; drawn box 50×100, centred → left 25; minus bbox origin ×scale
    expect(ctx.ops).toEqual([
      ['save'], ['translate', 0, -25], ['scale', 2.5, 2.5], ['fill', tall.d, 'evenodd', '#abc'], ['restore'],
    ])
  })
  it('strokes before filling, with the line width divided by the scale', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 20, h: 40, fill: '#fff', stroke: { color: '#000', width: 4 } })
    expect(ctx.ops.map(o => o[0])).toEqual(['save', 'translate', 'scale', 'stroke', 'fill', 'restore'])
    expect(ctx.ops[3]).toEqual(['stroke', tall.d, '#000', 4])
  })
  it('is a no-op for an empty target box', async () => {
    const { drawShape } = await import('../../app/lib/shapes/path2d')
    const ctx = new RecCtx()
    drawShape(ctx as unknown as CanvasRenderingContext2D, tall, { x: 0, y: 0, w: 0, h: 10, fill: '#fff' })
    expect(ctx.ops).toEqual([])
  })
  it('caches one Path2D per shape id', async () => {
    const { shapePath2D } = await import('../../app/lib/shapes/path2d')
    expect(shapePath2D(tall)).toBe(shapePath2D(tall))
  })
})
