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
    const out = insertFromOps(layers, ops, palette)
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
    const out = insertFromOps([title], ops, palette)
    expect(out.layers).toHaveLength(1)
    expect(out.inserted.size).toBe(0)
    expect(out.ops).toEqual(ops)
  })
})
