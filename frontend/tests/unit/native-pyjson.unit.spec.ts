/**
 * pyDumps writes JSON the way Python's json.dumps / json.dump(indent=2) does
 * (ensure_ascii escapes, ", "/": " separators, float repr), so files Sailor
 * writes natively are byte-identical to the ones ComfyUI wrote. Expected
 * strings were printed by Python 3 from the same values.
 */
import { describe, expect, it } from 'vitest'
import { pyDumps } from '../../server/native/pyJson'

// 1e16/1.5e16 are deliberately absent from this fixture: they are >= 2^53, so
// every double that large is integer-valued (IEEE754 has no fractional bits
// left up there) and pyNumber now treats it as a Python int (see the
// dedicated integer-boundary tests below) rather than routing it through
// pyFloat's exponent-notation branch, which the old fixture exercised.
const value = {
  a: [1, 2.5, { b: null, c: true }],
  s: 'é"\\\n\u0001\u007f😀',
  e: {},
  l: [],
  f: [0.04, 1e-05, 123456789.125, 1e-7, 0.0001, -3.25, 1e22, 5e-324],
}

describe('pyDumps', () => {
  it('matches json.dumps (compact, default separators)', () => {
    expect(pyDumps(value)).toBe(
      '{"a": [1, 2.5, {"b": null, "c": true}], "s": "\\u00e9\\"\\\\\\n\\u0001\\u007f\\ud83d\\ude00", "e": {}, "l": [], '
      + '"f": [0.04, 1e-05, 123456789.125, 1e-07, 0.0001, -3.25, 1e+22, 5e-324]}',
    )
  })

  it('matches json.dump(indent=2)', () => {
    expect(pyDumps({ a: [1, { b: null }], e: {}, l: [], s: 'é' }, 2)).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "e": {},\n  "l": [],\n  "s": "\\u00e9"\n}',
    )
  })

  it('writes the short escapes and control characters like Python', () => {
    expect(pyDumps('\b\f\n\r\t\u001f')).toBe('"\\b\\f\\n\\r\\t\\u001f"')
  })

  it('drops undefined object fields and nulls undefined array items, as JSON does', () => {
    expect(pyDumps({ a: undefined, b: [undefined] })).toBe('{"b": [null]}')
  })

  it('writes an integer beyond 2^53 with its full decimal digits, not float notation', () => {
    // Python: json.dumps(9007199254740994) == "9007199254740994" (not "9007199254740994.0")
    expect(pyDumps(9007199254740994)).toBe('9007199254740994')
    expect(pyDumps(-9007199254740994)).toBe('-9007199254740994')
    // Python: json.dumps(12345678901234567000) == "12345678901234567000"
    expect(pyDumps(1.2345678901234567e+19)).toBe('12345678901234567000')
  })

  it('still writes -0 as 0, matching plain JSON.stringify(-0)', () => {
    expect(pyDumps(-0)).toBe('0')
  })

  it('falls back to float repr once a double can no longer hold an exact integer', () => {
    // 1e21 and beyond: Python floats in this range still print without an
    // exponent up to 1e16, then switch to exponent form (see pyFloat) —
    // beyond the exact-integer boundary this module hands off to pyFloat.
    expect(pyDumps(1e21)).toBe('1e+21')
  })
})
