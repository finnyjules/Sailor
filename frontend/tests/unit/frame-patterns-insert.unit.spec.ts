import { describe, it, expect } from 'vitest'
import { insertFromOps } from '~/lib/frame/patterns/insert'
import type { LayerOp } from '~/lib/frame/patterns/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
const title: any = { id: 't', kind: 'text', x: .5, y: .5, rotation: 0, opacity: 1, text: 'NOISE', fontFamily: 'Inter', fontWeight: 700, fontSize: .2, color: '#000', align: 'left', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }

describe('insertFromOps', () => {
  it('creates a real path layer for a sentinel shape op and retargets the op', () => {
    const ops: LayerOp[] = [
      { target: 'shape', kind: 'shape', x: .4, y: .6, w: .7, shapeId: 'circle', colorRole: 'accent', fill: 'solid', z: 0 },
      { target: 'title', kind: 'text', x: .5, y: .5, fontSize: .2, colorRole: 'ink', z: 1 },
    ]
    const layers: LocalLayer[] = [title]
    const out = insertFromOps(layers, ops, palette, 'poster-test-1')
    expect(layers).toHaveLength(1)                                   // input untouched
    expect(out.layers).toHaveLength(2)
    const added: any = out.layers[1]
    expect(added.kind).toBe('path')
    expect(added.shapeId).toBe('circle')
    expect(added.d.length).toBeGreaterThan(0)                        // real geometry from the factory
    expect([added.x, added.y]).toEqual([.4, .6])
    expect(added.fill).toBe('#dd2200')                               // accent role → hex
    expect(out.inserted.get(0)).toBe(added.id)
    expect(out.ops[0]!.target).toBe(added.id)                        // op retargeted to the new layer
    expect(out.ops[1]).toEqual(ops[1])                               // other ops untouched
  })
  it('passes a non-sentinel shape op and an unknown shapeId through untouched', () => {
    const ops: LayerOp[] = [
      { target: 's1', kind: 'shape', x: .5, y: .5, w: .3, shapeId: 'circle' },          // real layer target
      { target: 'shape', kind: 'shape', x: .5, y: .5, w: .3, shapeId: 'no-such-shape' }, // unknown id
    ]
    const out = insertFromOps([title], ops, palette, 'poster-test-1')
    expect(out.layers).toHaveLength(1)
    expect(out.inserted.size).toBe(0)
    expect(out.ops).toEqual(ops)
  })

  describe('insertFromOps — deterministic ids', () => {
    const paletteForIds = { ink: '#111', accent: '#e33', field: '#eee' } as any
    const shapeOp = { target: 'shape', kind: 'shape', shapeId: 'circle', x: 0.5, y: 0.5, w: 0.3, colorRole: 'accent' } as any

    it('gives an inserted shape a deterministic id from the idBase and op index', () => {
      const a = insertFromOps([], [shapeOp], paletteForIds, 'poster-shapeCounter-7')
      const b = insertFromOps([], [shapeOp], paletteForIds, 'poster-shapeCounter-7')
      const idA = a.layers[a.layers.length - 1]!.id
      const idB = b.layers[b.layers.length - 1]!.id
      expect(idA).toBe('poster-shapeCounter-7-0')     // idBase + op index
      expect(idB).toBe(idA)                            // same inputs → same id (preview == apply)
      expect(a.inserted.get(0)).toBe(idA)
      expect(a.ops[0]!.target).toBe(idA)               // op retargeted to the new id
    })

    it('a different seed yields a different id', () => {
      const a = insertFromOps([], [shapeOp], paletteForIds, 'poster-shapeCounter-7')
      const b = insertFromOps([], [shapeOp], paletteForIds, 'poster-shapeCounter-8')
      expect(a.layers.at(-1)!.id).not.toBe(b.layers.at(-1)!.id)
    })
  })

  describe('insertFromOps — image stand-in', () => {
    const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
    const imgOp = { target: 'image', kind: 'image', x: 0.5, y: 0.5, w: 1, h: 1.25, fill: 'photo' } as any

    it('inserts a stand-in image layer for the image sentinel and retargets the op', () => {
      const out = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3')
      const layer = out.layers.at(-1)! as any
      expect(layer.kind).toBe('image')
      expect(layer.standIn).toBe(true)
      expect(layer.id).toBe('poster-fullBleed-3-0')     // deterministic, matches the shape scheme
      expect(out.ops[0]!.target).toBe(layer.id)
    })
    it('is deterministic (same inputs → same id)', () => {
      const a = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3').layers.at(-1)!.id
      const b = insertFromOps([], [imgOp], palette, 'poster-fullBleed-3').layers.at(-1)!.id
      expect(a).toBe(b)
    })
  })
})
