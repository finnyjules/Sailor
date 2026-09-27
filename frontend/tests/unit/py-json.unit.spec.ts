/**
 * R3.1: Python's json.loads / json.dumps / str() / repr() in TypeScript
 * (shared/runner/pyJson.ts), against what the real Python gives
 * (scripts/runner_paid_fixtures.py --group machinery).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PY_STR_UNREADABLE, parsePyJson, pyFloatRepr, pyJsonDumps, pyStr } from '#shared/runner/pyJson'

interface Machinery {
  bodies: ({ text: string; dumps: string } | { text: string; error: string })[]
  scalars: { text: string; str: string }[]
  floats: { bits: string; repr: string }[]
}
const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-machinery.json'), 'utf8')) as Machinery

const fromBits = (hex: string) => new DataView(Uint8Array.from(hex.match(/../g)!.map(h => Number.parseInt(h, 16))).buffer).getFloat64(0, false)

describe('parsePyJson + pyJsonDumps = json.dumps(json.loads(text))', () => {
  it('covers the cases the brief names', () => {
    const texts = FIX.bodies.map(b => b.text).join('\n')
    for (const needle of ['9007199254740993', '1.0', '1e5', '1E-7', '-0.0', 'NaN', 'Infinity', '"a": 3', 'café', '\\ud83d']) expect(texts).toContain(needle)
    expect(FIX.bodies.filter(b => 'error' in b).length).toBeGreaterThan(10)
  })
  for (const [i, b] of FIX.bodies.entries()) {
    it(`body ${i}: ${JSON.stringify(b.text).slice(0, 60)}`, () => {
      if ('error' in b) expect(() => parsePyJson(b.text)).toThrow()
      else expect(pyJsonDumps(parsePyJson(b.text))).toBe(b.dumps)
    })
  }
})

describe('pyFloatRepr = repr(float)', () => {
  it('matches Python on 10,000 recorded doubles', () => {
    expect(FIX.floats).toHaveLength(10_000)
    const wrong: string[] = []
    for (const f of FIX.floats) {
      const got = pyFloatRepr(fromBits(f.bits))
      if (got !== f.repr) wrong.push(`${f.bits}: ${got} ≠ ${f.repr}`)
    }
    expect(wrong).toEqual([])
  })
  it('keeps the sign of zero and names the non-finite ones as repr does', () => {
    expect([pyFloatRepr(0), pyFloatRepr(-0), pyFloatRepr(Number.NaN), pyFloatRepr(Infinity), pyFloatRepr(-Infinity)])
      .toEqual(['0.0', '-0.0', 'nan', 'inf', '-inf'])
  })
})

describe('pyStr = str() of a JSON scalar', () => {
  for (const s of FIX.scalars) {
    it(`str(json.loads(${s.text}))`, () => {
      expect(pyStr(parsePyJson(s.text))).toBe(s.str)
    })
  }
  it('refuses a list or a dict with the plain words', () => {
    expect(() => pyStr(parsePyJson('[1]'))).toThrow(PY_STR_UNREADABLE)
    expect(() => pyStr(parsePyJson('{"a": 1}'))).toThrow(PY_STR_UNREADABLE)
  })
})

describe('what the parse keeps', () => {
  it('keeps ints as their digits, floats as floats, and a repeated key in its first place', () => {
    expect(parsePyJson('{"a": 1, "b": 1.0, "a": 18446744073709551617}')).toEqual({ obj: [['a', { int: '18446744073709551617' }], ['b', { float: 1 }]] })
    expect(parsePyJson('-0')).toEqual({ int: '0' })
  })
})
