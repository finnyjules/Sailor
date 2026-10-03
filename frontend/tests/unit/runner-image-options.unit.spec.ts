/**
 * Guards on the image builders' readers (B4 review minors, folded into B5):
 * - `optInt` (generators/opts.ts) and `optionInt` (shared/runner/eligibility.ts,
 *   reached through isRunnerEligible) read an int the way Python's int() does,
 *   underscores and int()'s own blanks included, through one shared grammar
 *   (shared/runner/pyText.ts), and agree with each other;
 * - every `_X_AR = {...}` ratio set in comfy_api_nodes/image_models.py is the
 *   same set in generators/image.ts, or is named here as not ported, with why.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { asInt, optInt } from '~~/server/runner/generators/opts'
import { pyMod } from '#shared/runner/pyText'
import { IMAGE_RATIO_SETS } from '~~/server/runner/generators/image'
import { isRunnerEligible } from '#shared/runner/eligibility'

describe('int readers follow Python int()', () => {
  // [value, what int(str(value)) gives, or null where it raises]
  const TABLE: [string, number | null][] = [
    ['7', 7], [' 7 ', 7], ['-2', -2], ['+3', 3], ['1_0', 10], ['1_000', 1000], ['-1_2', -12],
    ['_1', null], ['1_', null], ['1__0', null], ['2.5', null], ['abc', null], ['', null], ['1 0', null],
    // int() strips its own blanks, not JS trim()'s: U+FEFF is not one, nor are
    // U+001C–U+001F (though str.strip() takes those); U+0085 and U+3000 are.
    ['\ufeff7', null], ['\x1c7', null], ['7\x1f', null], ['\x857', 7], ['\u30007\u3000', 7], ['\xa0-7', -7],
  ]
  it.each(TABLE)('optInt(%j)', (v, want) => {
    expect(optInt({ k: v }, 'k', -99)).toBe(want ?? -99)
  })
  it.each(TABLE)('optionInt(%j) agrees (num_outputs > 1 goes to Python)', (v, want) => {
    const p = { 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'p', model_options: JSON.stringify({ num_outputs: v }) } } }
    // optionInt's default is 1: an unreadable value asks for one picture.
    expect(isRunnerEligible(p)).toBe(!((want ?? 1) > 1))
  })
  it.each(TABLE)('asInt(%j) agrees (widget seeds and durations)', (v, want) => {
    expect(asInt(v, -99)).toBe(want ?? -99)
  })
  it('asInt keeps numbers (truncated) and gives the default for anything else', () => {
    expect(asInt(7.9, 0)).toBe(7)
    expect(asInt(-7.9, 0)).toBe(-7)
    expect(asInt(Number.NaN, 5)).toBe(5)
    expect(asInt(null, 5)).toBe(5)
  })
})

describe('pyMod is Python’s float %', () => {
  it.each([
    [-1, 360, 359], [361, 360, 1], [0, 360, 0], [720, 360, 0], [-30.5, 360, 329.5], [5, -3, -1], [-5, 3, 1],
  ])('%s %% %s is %s', (a, n, want) => {
    expect(pyMod(a, n)).toBe(want)
  })
  it('a tiny negative lands on the divisor, as fmod-then-add does in CPython', () => {
    expect(pyMod(-1e-20, 360)).toBe(360)
  })
})

describe('ratio sets match comfy_api_nodes/image_models.py (frozen at C7)', () => {
  const frozen = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/python-image-ratio-sets.json', import.meta.url)), 'utf8')).sets as Record<string, string[]>
  const python = new Map<string, Set<string>>(Object.entries(frozen).map(([k, v]) => [k, new Set(v)]))
  // Sets whose builders the runner does not port.
  const NOT_PORTED: Record<string, string> = {
    _IDEOGRAM_V3_AR: 'ideogram-v3 runs on fal, which takes image_size; its Replicate builder is not ported',
    _REVE_AR: 'reve-create is unpriced, so the runner does not take it',
    _KREA_AR: 'krea-2-large and krea-2-medium are priced, but the runner takes them only with their own family (not built yet)',
  }

  it('the frozen file has the sets (every `_X_AR =` line was parsed when it was frozen)', () => {
    expect(python.size).toBeGreaterThan(20)
    expect(python.get('_OPENAI_AR')).toEqual(new Set(['1:1', '3:2', '2:3']))
  })
  it('every Python set is ported the same, or named as not ported', () => {
    for (const [name, set] of python) {
      if (name in NOT_PORTED) {
        expect(IMAGE_RATIO_SETS[name], name).toBeUndefined()
        continue
      }
      expect(IMAGE_RATIO_SETS[name], `${name} is missing from generators/image.ts`).toBeDefined()
      expect([...IMAGE_RATIO_SETS[name]!].sort(), name).toEqual([...set].sort())
    }
  })
  it('every TS set is a Python set', () => {
    for (const name of Object.keys(IMAGE_RATIO_SETS)) expect(python.has(name), name).toBe(true)
  })
})
