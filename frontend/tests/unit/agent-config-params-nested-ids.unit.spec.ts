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
})
