import { describe, it, expect } from 'vitest'
import {
  activeVersionIndex, effectIdForVersion, expandMyEffect, isPickable, myEffectIdOf, recordFromTake,
  valuesForVersion, withCodeVersion, withValuesVersion,
} from '~/lib/myEffects/defs'
import { assembleSource } from '~~/shared/shadergen/contract'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const t1 = SPIKE_TAKES.rain![2]!
const t2 = SPIKE_TAKES.rain![0]!
const now = '2026-09-25T10:00:00.000Z'
const base = () => recordFromTake(t1, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: 'Water ripple', now })

describe('My effects: records and versions (spec §7.4)', () => {
  it('a kept take becomes v1 with its code, dials at their defaults, and the request as the note', () => {
    const r = base()
    expect(r.name).toBe(t1.name)
    expect(r.from).toBe('Water ripple')
    expect(r.versions).toHaveLength(1)
    expect(r.versions[0]).toMatchObject({ label: 'v1', body: t1.body, note: 'rain on a window' })
    expect(r.versions[0]!.values).toEqual(Object.fromEntries(t1.params.map(p => [p.uniform, p.default])))
  })

  it('expands to one EffectDef per CODE version; the newest under the record id', () => {
    const r = withValuesVersion(withCodeVersion(base(), t2, { request: 'heavier', now }), { [t2.params[0]!.uniform]: 0.9 }, { request: 'less', now })!
    const defs = expandMyEffect(r)
    expect(defs.map(d => d.id)).toEqual(['mine_aaaaaaaaaaaa', 'mine_aaaaaaaaaaaa~v1'])
    const [main, old] = defs
    expect(main).toMatchObject({ mine: true, from: 'Water ripple', category: 'mine', source: assembleSource(t2.body) })
    expect(old).toMatchObject({ mine: true, versionOf: 'mine_aaaaaaaaaaaa', source: assembleSource(t1.body) })
    expect(main!.versions!.map(v => [v.label, v.effectId])).toEqual([
      ['v1', 'mine_aaaaaaaaaaaa~v1'], ['v2', 'mine_aaaaaaaaaaaa'], ['v3', 'mine_aaaaaaaaaaaa'],
    ])
    expect(isPickable(main!)).toBe(true)
    expect(isPickable(old!)).toBe(false)
    expect(isPickable({ ...main!, draft: true })).toBe(false)
  })

  it('a dial version keeps its code version’s id and lays its values over that code’s defaults', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(r.versions.map(v => v.label)).toEqual(['v1', 'v2'])
    expect(effectIdForVersion(r, 1)).toBe('mine_aaaaaaaaaaaa')
    expect(valuesForVersion(r, 1)[t1.params[0]!.uniform]).toBe(0.123)
  })

  it('no dial version when nothing changed', () => {
    const r = base()
    expect(withValuesVersion(r, { ...r.versions[0]!.values }, { request: 'same', now })).toBeNull()
  })

  it('the pressed chip is the newest version matching the effect id and the values', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', valuesForVersion(r, 1))).toBe(1)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', valuesForVersion(r, 0))).toBe(0)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', { [t1.params[0]!.uniform]: 0.5555 })).toBeNull()
  })

  it('a target that omits dials is filled from the effect’s own defaults, not from whichever version it is compared to (C11)', () => {
    // Without the fix, comparing an incomplete target against each version's OWN
    // values (spreading the target over that version) makes every version trivially
    // equal to itself, so `{}` would always press the newest chip.
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', {})).toBe(0)
  })

  it('reads a record id out of an effect id', () => {
    expect(myEffectIdOf('mine_aaaaaaaaaaaa')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('mine_aaaaaaaaaaaa~v3')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('water_ripple')).toBeNull()
  })
})
