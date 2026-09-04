/**
 * Drift guard for `VT_PRESET_IN_TO_OUT` (`~/lib/vectortype/movesAdapter.ts`).
 *
 * That map's own doc comment claims every id in it "is checked against
 * [the kinetic engine's `IN_EVAL`/`OUT_EVAL`] catalog by this module's own
 * test suite, so a preset added or renamed there cannot silently drift out
 * of step" — this is that test. Before this file existed, the claim was
 * false: the 17 pairs happened to be correct, but nothing would have caught
 * a rename in `~/lib/motion/evaluate.ts`'s `IN_EVAL`/`OUT_EVAL` tables
 * breaking the map's In/Out toggle silently (wired in a later task).
 *
 * `IN_EVAL`/`OUT_EVAL` themselves are module-private in `evaluate.ts`; the
 * id sets they key are exported as `SUPPORTED_IN_IDS`/`SUPPORTED_OUT_IDS`
 * (`Object.keys(IN_EVAL)`/`Object.keys(OUT_EVAL)` respectively — see that
 * file), which is what this test validates against instead of reaching into
 * the tables directly.
 */
import { describe, expect, it } from 'vitest'
import {
  VT_PRESET_IN_TO_OUT,
  vtPresetDirection,
  vtPresetFlip,
} from '~/lib/vectortype/movesAdapter'
import { SUPPORTED_IN_IDS, SUPPORTED_OUT_IDS } from '~/lib/motion/evaluate'

const IN_IDS = new Set(SUPPORTED_IN_IDS)
const OUT_IDS = new Set(SUPPORTED_OUT_IDS)

describe('VT_PRESET_IN_TO_OUT — drift guard against the kinetic catalog', () => {
  it('has at least the 17 pairs the doc comment describes', () => {
    expect(Object.keys(VT_PRESET_IN_TO_OUT).length).toBeGreaterThanOrEqual(17)
  })

  it('every key is a real IN preset id in the live catalog', () => {
    for (const inId of Object.keys(VT_PRESET_IN_TO_OUT)) {
      expect(IN_IDS.has(inId), `"${inId}" (key) is missing from SUPPORTED_IN_IDS`).toBe(true)
    }
  })

  it('every value is a real OUT preset id in the live catalog', () => {
    for (const [inId, outId] of Object.entries(VT_PRESET_IN_TO_OUT)) {
      expect(OUT_IDS.has(outId), `"${outId}" (value for "${inId}") is missing from SUPPORTED_OUT_IDS`).toBe(true)
    }
  })

  it('keys and values are disjoint — no id is claimed as both In and Out', () => {
    const keys = new Set(Object.keys(VT_PRESET_IN_TO_OUT))
    for (const outId of Object.values(VT_PRESET_IN_TO_OUT)) {
      expect(keys.has(outId), `"${outId}" appears as both a key and a value`).toBe(false)
    }
  })

  it('no two In ids are paired with the same Out id', () => {
    const seen = new Map<string, string>()
    for (const [inId, outId] of Object.entries(VT_PRESET_IN_TO_OUT)) {
      const dupeOf = seen.get(outId)
      expect(dupeOf, `"${outId}" is claimed by both "${dupeOf}" and "${inId}"`).toBeUndefined()
      seen.set(outId, inId)
    }
  })
})

describe('vtPresetDirection / vtPresetFlip — one known pair, classified correctly', () => {
  it('classifies fade-in as "in" and fade-out as "out"', () => {
    expect(vtPresetDirection('fade-in')).toBe('in')
    expect(vtPresetDirection('fade-out')).toBe('out')
  })

  it('flips fade-in to fade-out and back', () => {
    expect(vtPresetFlip('fade-in')).toBe('fade-out')
    expect(vtPresetFlip('fade-out')).toBe('fade-in')
  })
})
