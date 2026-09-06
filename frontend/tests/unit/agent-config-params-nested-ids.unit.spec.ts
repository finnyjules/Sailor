import { describe, it, expect } from 'vitest'
import { makeConfigParams } from '~/lib/agent/configParams'

const doc = () => ({
  objects: [
    { id: 'A', material: { roughness: 0.5 }, treatments: [{ id: 't1', kind: 'blur', amount: 0.2 }] },
  ],
})

describe('makeConfigParams: nested id-addressed lists', () => {
  it('reads and writes objects.<id>.treatments.<tid>.<dial>', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.t1.amount']).toBe(0.2)
    p['objects.A.treatments.t1.amount'] = 0.7
    expect(cfg.objects[0]!.treatments[0]!.amount).toBe(0.7)
  })
  it('an unknown nested id reads undefined and writes nothing — no key fabricated on the array', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.zzz.amount']).toBeUndefined()
    p['objects.A.treatments.zzz.amount'] = 1
    expect(cfg).toEqual(doc())
    expect(Object.keys(cfg.objects[0]!.treatments)).toEqual(['0'])
  })
  it('single-level paths are unchanged', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    p['objects.A.material.roughness'] = 0.9
    expect(cfg.objects[0]!.material.roughness).toBe(0.9)
  })
  it('an out-of-range numeric nested segment reads undefined and writes nothing — no sparse slot fabricated', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.5.amount']).toBeUndefined()
    p['objects.A.treatments.5.amount'] = 1
    expect(cfg).toEqual(doc())
    expect(cfg.objects[0]!.treatments).toHaveLength(1)
  })
  it('an in-range numeric nested segment still reads and writes', () => {
    const cfg = doc()
    const p = makeConfigParams(() => cfg, () => 0, 'objects', 'id', 'object')
    expect(p['objects.A.treatments.0.amount']).toBe(0.2)
    p['objects.A.treatments.0.amount'] = 0.6
    expect(cfg.objects[0]!.treatments[0]!.amount).toBe(0.6)
  })
  it('a non-default idKey is honoured for nested lists', () => {
    const cfg = { layers: [{ layerId: 'L1', stops: [{ layerId: 's1', v: 1 }] }] }
    const p = makeConfigParams(() => cfg, () => 0, 'layers', 'layerId', 'layer')
    expect(p['layers.L1.stops.s1.v']).toBe(1)
    p['layers.L1.stops.s1.v'] = 42
    expect(cfg.layers[0]!.stops[0]!.v).toBe(42)
  })
})
