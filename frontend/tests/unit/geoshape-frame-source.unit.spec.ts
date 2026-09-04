// frontend/tests/unit/geoshape-frame-source.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { makeShapeFrameSource } from '~/lib/geoshape/frameSource'

const persisted = (over: any = {}) => ({ canvasW: 800, canvasH: 600, ...over })

describe('makeShapeFrameSource', () => {
  it('reports duration 0 (Shape Studio is a still, not a clock)', () => {
    const src = makeShapeFrameSource({ getPersisted: () => persisted(), render: async () => ({} as any) })
    expect(src.duration).toBe(0)
  })

  it('reports width/height from the persisted canvas dims', () => {
    const src = makeShapeFrameSource({ getPersisted: () => persisted(), render: async () => ({} as any) })
    expect(src.width).toBe(800)
    expect(src.height).toBe(600)
  })

  it('falls back to a default square when canvas dims are missing', () => {
    const src = makeShapeFrameSource({ getPersisted: () => undefined, render: async () => ({} as any) })
    expect(src.width).toBe(1024)
    expect(src.height).toBe(1024)
  })

  it('reads dims lazily so later edits are picked up', () => {
    let w = 800
    const src = makeShapeFrameSource({ getPersisted: () => persisted({ canvasW: w }), render: async () => ({} as any) })
    expect(src.width).toBe(800)
    w = 1200
    expect(src.width).toBe(1200)
  })

  it('passes the requested render size straight through', async () => {
    const sizes: Array<[number, number]> = []
    const src = makeShapeFrameSource({
      getPersisted: () => persisted(),
      render: async (rw, rh) => { sizes.push([rw, rh]); return {} as any },
    })
    await src.getFrame(0, 640, 360)
    expect(sizes).toEqual([[640, 360]])
  })
})
