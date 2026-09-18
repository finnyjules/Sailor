import { describe, it, expect } from 'vitest'
import { SPACE_TYPE_EFFECTS, getEffect } from '../../app/lib/spacetype/effects'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from '../../app/lib/spacetype/effect'
import { SEPARATOR_CONTROLS, separatorEligible, separatorFromParams, withSeparatorControls, PER_GLYPH_SEPARATOR_READY } from '../../app/lib/spacetype/separator'
import { showIfVisible } from '../../app/lib/studio/sections'
import { texOptsFromState, defaultSpaceTypeState } from '../../app/lib/spacetype/state'
import { buildTexOpts } from '~/lib/embed/surfaces/spacetype'
import { ribbonEffect } from '../../app/lib/spacetype/effects/ribbon'

const KEYS = ['separator', 'separatorSize', 'separatorGap']

// Written out rather than derived from RAW_WORD_EFFECTS/PER_GLYPH_EFFECTS: a
// test that recomputes the implementation's own predicate agrees with it no
// matter what either says, so it would stay green if an effect silently moved
// in or out of those sets. This literal list is the second opinion — an
// effect changing eligibility has to be a deliberate edit here too. Every id
// is asserted to still exist below, so the list cannot rot into a no-op.
const INELIGIBLE = ['coil', 'elastic', 'echo', 'blend', 'cascade', 'onionburst', 'ring', 'slot', 'pile']

describe('separator controls are injected once at registration', () => {
  it('every ineligible id is still a registered effect', () => {
    expect(INELIGIBLE.every(id => SPACE_TYPE_EFFECTS.some(e => e.id === id))).toBe(true)
  })
  for (const e of SPACE_TYPE_EFFECTS) {
    const eligible = !INELIGIBLE.includes(e.id)
    // Per-glyph effects (cylinder) place glyphs at uniform angles by index, so separatorGap
    // — which only pads the tile atlas — is dead there; they get separator + separatorSize only.
    const expectedKeys = !eligible ? [] : PER_GLYPH_SEPARATOR_READY.has(e.id) ? ['separator', 'separatorSize'] : KEYS
    it(`${e.id}: ${eligible ? 'has' : 'lacks'} the Type controls`, () => {
      const keys = e.controls.filter(c => KEYS.includes(c.key)).map(c => c.key)
      expect(keys).toEqual(expectedKeys)
      expect(separatorEligible(e.id)).toBe(eligible)
      // The implementation's own predicate must agree with the literal list. cylinder is the
      // one PER_GLYPH_EFFECTS id carved back in by PER_GLYPH_SEPARATOR_READY (see separator.ts).
      expect(!RAW_WORD_EFFECTS.has(e.id) && (!PER_GLYPH_EFFECTS.has(e.id) || PER_GLYPH_SEPARATOR_READY.has(e.id))).toBe(eligible)
      for (const c of e.controls.filter(c => KEYS.includes(c.key))) expect(c.group).toBe('Type')
    })
  }
  it('cylinder has no separatorGap control (angular placement by index ignores it)', () => {
    expect(getEffect('cylinder').controls.some(c => c.key === 'separatorGap')).toBe(false)
  })
  it('is idempotent and does not touch ineligible effects', () => {
    const twice = withSeparatorControls(withSeparatorControls(ribbonEffect))
    expect(twice.controls.filter(c => c.key === 'separator').length).toBe(1)
    expect(withSeparatorControls(getEffect('coil'))).toBe(getEffect('coil'))
  })
  it('size and gap hide while separator is none', () => {
    const size = SEPARATOR_CONTROLS.find(c => c.key === 'separatorSize')!
    expect(showIfVisible(size, () => 'none')).toBe(false)
    expect(showIfVisible(size, () => 'sparkle')).toBe(true)
  })
  it('getEffect returns the injected effect; defaults include separator: none', () => {
    const ribbon = getEffect('ribbon')
    expect(ribbon.controls.some(c => c.key === 'separator')).toBe(true)
    expect(defaultSpaceTypeState().params.separator).toBe('none')
  })
  it('cylinder is the one per-glyph effect that takes a separator', () => {
    expect(separatorEligible('cylinder')).toBe(true)
    for (const id of ['blend', 'cascade', 'onionburst', 'ring', 'slot']) expect(separatorEligible(id)).toBe(false)
    expect(getEffect('cylinder').controls.some(c => c.key === 'separator')).toBe(true)
  })
})

describe('separatorFromParams', () => {
  it('resolves a valid id with size/gap and their defaults', () => {
    const s = separatorFromParams('ribbon', { separator: 'sparkle', separatorSize: 1.2, separatorGap: 0.5 })
    expect(s?.shape.id).toBe('sparkle'); expect(s?.size).toBe(1.2); expect(s?.gap).toBe(0.5)
    const d = separatorFromParams('ribbon', { separator: 'sparkle' })
    expect(d?.size).toBe(0.7); expect(d?.gap).toBe(1)
  })
  it('is undefined for none, unknown ids, and ineligible effects', () => {
    expect(separatorFromParams('ribbon', { separator: 'none' })).toBeUndefined()
    expect(separatorFromParams('ribbon', {})).toBeUndefined()
    expect(separatorFromParams('ribbon', { separator: 'unicorn' })).toBeUndefined()
    expect(separatorFromParams('coil', { separator: 'sparkle' })).toBeUndefined()
    expect(separatorFromParams('ring', { separator: 'sparkle' })).toBeUndefined()
  })
})

describe('both tile-option builders carry the separator', () => {
  it('texOptsFromState', () => {
    const st = defaultSpaceTypeState()
    expect(texOptsFromState(st).separator).toBeUndefined()
    st.params.separator = 'sun-rays'
    expect(texOptsFromState(st).separator?.shape.id).toBe('sun-rays')
  })
  it('embed buildTexOpts', () => {
    const p = { ...defaultSpaceTypeState().params, separator: 'sun-rays' }
    expect(buildTexOpts(ribbonEffect, p, null, []).separator?.shape.id).toBe('sun-rays')
    expect(buildTexOpts(ribbonEffect, { ...p, separator: 'none' }, null, []).separator).toBeUndefined()
  })
})
