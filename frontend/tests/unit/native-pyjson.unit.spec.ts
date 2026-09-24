/**
 * pyDumps writes JSON the way Python's json.dumps / json.dump(indent=2) does
 * (ensure_ascii escapes, ", "/": " separators, float repr), so files Sailor
 * writes natively are byte-identical to the ones ComfyUI wrote. Expected
 * strings were printed by Python 3 from the same values.
 */
import { describe, expect, it } from 'vitest'
import { pyDumps } from '../../server/native/pyJson'

const value = {
  a: [1, 2.5, { b: null, c: true }],
  s: 'é"\\\n\u0001\u007f😀',
  e: {},
  l: [],
  f: [0.04, 1e-05, 1e16, 1.5e16, 123456789.125, 1e-7, 0.0001, -3.25, 1e22, 5e-324],
}

describe('pyDumps', () => {
  it('matches json.dumps (compact, default separators)', () => {
    expect(pyDumps(value)).toBe(
      '{"a": [1, 2.5, {"b": null, "c": true}], "s": "\\u00e9\\"\\\\\\n\\u0001\\u007f\\ud83d\\ude00", "e": {}, "l": [], '
      + '"f": [0.04, 1e-05, 1e+16, 1.5e+16, 123456789.125, 1e-07, 0.0001, -3.25, 1e+22, 5e-324]}',
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
})
