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
import { optInt } from '~~/server/runner/generators/opts'
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
})

describe('ratio sets match comfy_api_nodes/image_models.py', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../comfy_api_nodes/image_models.py', import.meta.url)), 'utf8')
  const python = new Map<string, Set<string>>()
  for (const m of src.matchAll(/^(_[A-Z0-9_]+_AR)\s*=\s*\{([^}]*)\}/gm)) {
    python.set(m[1]!, new Set([...m[2]!.matchAll(/"([^"]+)"/g)].map(x => x[1]!)))
  }
  // Sets whose builders the runner does not port.
  const NOT_PORTED: Record<string, string> = {
    _IDEOGRAM_V3_AR: 'ideogram-v3 runs on fal, which takes image_size; its Replicate builder is not ported',
    _REVE_AR: 'reve-create is unpriced, so the runner does not take it',
    _KREA_AR: 'krea-2-large and krea-2-medium are unpriced, so the runner does not take them',
  }

  it('the Python file has the sets (the parser works)', () => {
    expect(python.size).toBeGreaterThan(20)
    // Every `_X_AR =` line was parsed: a set the parser skipped would go unchecked.
    expect(python.size).toBe(src.match(/^_[A-Z0-9_]+_AR\s*=/gm)!.length)
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
