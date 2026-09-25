import { describe, it, expect } from 'vitest'
import {
  activeVersionIndex, effectIdForVersion, expandMyEffect, isPickable, myEffectIdOf, newestEffectId, pickableIdFor, recordFromTake,
  storedEffectId, valuesForVersion, withCodeVersion, withValuesVersion,
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

  it('expands to one EffectDef per CODE version, each under its own explicit id; the bare id is a hidden v1', () => {
    const r = withValuesVersion(withCodeVersion(base(), t2, { request: 'heavier', now }), { [t2.params[0]!.uniform]: 0.9 }, { request: 'less', now })!
    const defs = expandMyEffect(r)
    expect(defs.map(d => d.id)).toEqual(['mine_aaaaaaaaaaaa~v2', 'mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa'])
    const [main, old, legacy] = defs
    expect(main).toMatchObject({ mine: true, from: 'Water ripple', category: 'mine', name: t1.name, source: assembleSource(t2.body) })
    expect(main!.versionOf).toBeUndefined()
    expect(old).toMatchObject({ mine: true, versionOf: 'mine_aaaaaaaaaaaa', name: `${t1.name} · v1`, source: assembleSource(t1.body) })
    // A target stored with the bare id before pinning reads as version 1.
    expect(legacy).toMatchObject({ versionOf: 'mine_aaaaaaaaaaaa', source: assembleSource(t1.body) })
    expect(main!.versions!.map(v => [v.label, v.effectId])).toEqual([
      ['v1', 'mine_aaaaaaaaaaaa~v1'], ['v2', 'mine_aaaaaaaaaaaa~v2'], ['v3', 'mine_aaaaaaaaaaaa~v2'],
    ])
    expect(isPickable(main!)).toBe(true)
    expect(isPickable(old!)).toBe(false)
    expect(isPickable(legacy!)).toBe(false)
    expect(isPickable({ ...main!, draft: true })).toBe(false)
    expect(newestEffectId(r)).toBe('mine_aaaaaaaaaaaa~v2')
  })

  it('a single-version effect: v1 is the pickable entry and the bare id renders the same code', () => {
    const defs = expandMyEffect(base())
    expect(defs.map(d => d.id)).toEqual(['mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa'])
    expect(defs[1]!.source).toBe(defs[0]!.source)
    expect(isPickable(defs[0]!)).toBe(true)
    expect(isPickable(defs[1]!)).toBe(false)
  })

  it('adding a code version never changes what a target pinned to v1 renders (Ruling #2)', () => {
    const v1 = expandMyEffect(base())
    const pinned = v1.find(d => isPickable(d))!.id // what a pick (or a Keep) writes
    const v2 = expandMyEffect(withCodeVersion(base(), t2, { request: 'heavier', now }))
    expect(v2.find(d => d.id === pinned)!.source).toBe(assembleSource(t1.body))
    expect(v2.find(d => d.id === 'mine_aaaaaaaaaaaa')!.source).toBe(assembleSource(t1.body))
    expect(v2.find(d => isPickable(d))!.source).toBe(assembleSource(t2.body))
  })

  it('a dial version keeps its code version’s id and lays its values over that code’s defaults', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(r.versions.map(v => v.label)).toEqual(['v1', 'v2'])
    expect(effectIdForVersion(r, 1)).toBe('mine_aaaaaaaaaaaa~v1')
    expect(valuesForVersion(r, 1)[t1.params[0]!.uniform]).toBe(0.123)
  })

  it('no dial version when nothing changed', () => {
    const r = base()
    expect(withValuesVersion(r, { ...r.versions[0]!.values }, { request: 'same', now })).toBeNull()
  })

  it('the pressed chip is the newest version matching the effect id and the values', () => {
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa~v1', valuesForVersion(r, 1))).toBe(1)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa~v1', valuesForVersion(r, 0))).toBe(0)
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa~v1', { [t1.params[0]!.uniform]: 0.5555 })).toBeNull()
    // A stored bare id reads as v1.
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa', valuesForVersion(r, 1))).toBe(1)
  })

  it('a target that omits dials is filled from the effect’s own defaults, not from whichever version it is compared to (C11)', () => {
    // Without the fix, comparing an incomplete target against each version's OWN
    // values (spreading the target over that version) makes every version trivially
    // equal to itself, so `{}` would always press the newest chip.
    const r = withValuesVersion(base(), { [t1.params[0]!.uniform]: 0.123 }, { request: 'softer', now })!
    expect(activeVersionIndex(r, 'mine_aaaaaaaaaaaa~v1', {})).toBe(0)
  })

  it('reads a record id out of an effect id', () => {
    expect(myEffectIdOf('mine_aaaaaaaaaaaa')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('mine_aaaaaaaaaaaa~v3')).toBe('mine_aaaaaaaaaaaa')
    expect(myEffectIdOf('water_ripple')).toBeNull()
  })

  it('a stored bare id reads as v1; a picker finds the effect’s one pickable entry from any of its ids', () => {
    expect(storedEffectId('mine_aaaaaaaaaaaa')).toBe('mine_aaaaaaaaaaaa~v1')
    expect(storedEffectId('mine_aaaaaaaaaaaa~v3')).toBe('mine_aaaaaaaaaaaa~v3')
    expect(storedEffectId('water_ripple')).toBe('water_ripple')
    const defs = expandMyEffect(withCodeVersion(base(), t2, { request: 'heavier', now }))
    for (const id of ['mine_aaaaaaaaaaaa', 'mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa~v2']) expect(pickableIdFor(id, defs)).toBe('mine_aaaaaaaaaaaa~v2')
    expect(pickableIdFor('water_ripple', defs)).toBe('water_ripple')
  })
})
