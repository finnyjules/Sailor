import { describe, it, expect } from 'vitest'
import { SPACE_TYPE_EFFECTS, getEffect } from '../../app/lib/spacetype/effects'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from '../../app/lib/spacetype/effect'
import { SEPARATOR_CONTROLS, separatorEligible, separatorFromParams, withSeparatorControls } from '../../app/lib/spacetype/separator'
import { showIfVisible } from '../../app/lib/studio/sections'
import { texOptsFromState, defaultSpaceTypeState } from '../../app/lib/spacetype/state'
import { buildTexOpts } from '~/lib/embed/surfaces/spacetype'
import { ribbonEffect } from '../../app/lib/spacetype/effects/ribbon'

const KEYS = ['separator', 'separatorSize', 'separatorGap']

describe('separator controls are injected once at registration', () => {
  for (const e of SPACE_TYPE_EFFECTS) {
    const eligible = !RAW_WORD_EFFECTS.has(e.id) && !PER_GLYPH_EFFECTS.has(e.id)
    it(`${e.id}: ${eligible ? 'has' : 'lacks'} the three Type controls`, () => {
      const keys = e.controls.filter(c => KEYS.includes(c.key)).map(c => c.key)
      expect(keys).toEqual(eligible ? KEYS : [])
      expect(separatorEligible(e.id)).toBe(eligible)
      for (const c of e.controls.filter(c => KEYS.includes(c.key))) expect(c.group).toBe('Type')
    })
  }
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
