import { describe, it, expect } from 'vitest'
import { MY_EFFECT_ID_RE, MY_EFFECT_LIMITS, newMyEffectId, validateMyEffect, type MyEffectRecord } from '~~/shared/myEffects/record'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const take = SPIKE_TAKES.rain![2]!
const rec = (over: Partial<MyEffectRecord> = {}): MyEffectRecord => ({
  id: 'mine_abcdefghij12', name: 'Rain on glass', from: null, animated: true, generative: false,
  createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ label: 'v1', body: take.body, params: take.params, values: {}, note: 'rain on a window', createdAt: '2026-09-25T00:00:00.000Z' }],
  ...over,
})

describe('My effect record', () => {
  it('ids look like mine_ + 12 base-36 characters', () => {
    const id = newMyEffectId()
    expect(id).toMatch(MY_EFFECT_ID_RE)
    expect(newMyEffectId(() => 0)).toBe('mine_000000000000')
  })
  it('accepts a valid record and returns a clean copy', () => {
    const r = validateMyEffect({ ...rec(), extra: 'dropped' })
    expect(r).toEqual(rec())
  })
  it('the first version must carry code', () => {
    expect(() => validateMyEffect(rec({ versions: [{ label: 'v1', values: {}, note: '', createdAt: 'x' }] }))).toThrow(/first version/)
  })
  it('rejects a bad id, an empty or long name, too many versions, a long body, a bad dial', () => {
    expect(() => validateMyEffect(rec({ id: 'rain' }))).toThrow(/id/)
    expect(() => validateMyEffect(rec({ name: '  ' }))).toThrow(/name/)
    expect(() => validateMyEffect(rec({ name: 'x'.repeat(MY_EFFECT_LIMITS.maxNameChars + 1) }))).toThrow(/name/)
    const v = rec().versions[0]!
    expect(() => validateMyEffect(rec({ versions: Array.from({ length: MY_EFFECT_LIMITS.maxVersions + 1 }, () => v) }))).toThrow(/versions/)
    expect(() => validateMyEffect(rec({ versions: [{ ...v, body: 'x'.repeat(20_000) }] }))).toThrow(/long/)
    // Three dials (within the 3–5 count) so it's the TYPE check that fires, not the count check (preflight C13).
    expect(() => validateMyEffect(rec({
      versions: [{
        ...v,
        params: [
          { uniform: 'u_a', label: 'A', type: 'gradient' as any, default: 0 },
          { uniform: 'u_b', label: 'B', type: 'float', default: 0 },
          { uniform: 'u_c', label: 'C', type: 'float', default: 0 },
        ],
      }],
    }))).toThrow(/dial/)
  })
  it('values are numbers or strings only', () => {
    const v = rec().versions[0]!
    expect(() => validateMyEffect(rec({ versions: [{ ...v, values: { u_a: { x: 1 } as any } }] }))).toThrow(/value/)
  })
})
