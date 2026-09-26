/**
 * R0.1: a runner node's results per output slot. A record written before
 * values existed reads exactly as before: every slot its files, or the
 * Frame's protect_mask slot from slotOutputs.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_VALUE_TEXT_CHARS, VALUE_NOT_FINITE, VALUE_TOO_LONG,
  checkValue, filesOf, filesOfValues, literalOf, slotValue,
} from '~~/server/runner/values'
import { emptyNodeRecord, type NodeRecord, type OutputFile } from '~~/server/runner/types'

const f = (filename: string, type: OutputFile['type'] = 'output'): OutputFile => ({ filename, subfolder: '', type })
const rec = (over: Partial<NodeRecord>): NodeRecord => ({ ...emptyNodeRecord('X'), ...over })

describe('slotValue', () => {
  it('reads a record without values as before: every slot its files', () => {
    const r = rec({ outputs: [f('a.png')] })
    expect(slotValue(r, 0)).toEqual({ kind: 'files', files: [f('a.png')] })
    expect(slotValue(r, 3)).toEqual({ kind: 'files', files: [f('a.png')] })
  })
  it('reads a later slot from slotOutputs when the record keeps them (the Frame protect_mask)', () => {
    const r = rec({ outputs: [f('a.png')], slotOutputs: { 1: [f('m.png', 'temp')] } })
    expect(slotValue(r, 1)).toEqual({ kind: 'files', files: [f('m.png', 'temp')] })
    expect(slotValue(r, 2)).toEqual({ kind: 'files', files: [] })
  })
  it('reads values by slot when the record has them, and nothing for a slot it lacks', () => {
    const r = rec({ values: { 0: { kind: 'text', text: 'hi' } } })
    expect(slotValue(r, 0)).toEqual({ kind: 'text', text: 'hi' })
    expect(slotValue(r, 1)).toBeUndefined()
  })
  it('reads nothing from a missing record', () => {
    expect(slotValue(undefined, 0)).toBeUndefined()
  })
})

describe('filesOf / literalOf', () => {
  it('names the files of files, mask and glb values only', () => {
    expect(filesOf({ kind: 'files', files: [f('a.png')] })).toEqual([f('a.png')])
    expect(filesOf({ kind: 'mask', files: [f('m.png', 'kept')] })).toEqual([f('m.png', 'kept')])
    expect(filesOf({ kind: 'glb', url: '/view?x', file: f('m.glb') })).toEqual([f('m.glb')])
    expect(filesOf({ kind: 'glb', url: 'https://x', file: null })).toEqual([])
    expect(filesOf({ kind: 'text', text: 'a' })).toEqual([])
    expect(filesOf(undefined)).toEqual([])
  })
  it('lists every file once across slots', () => {
    const a = f('a.png')
    expect(filesOfValues({ 0: { kind: 'files', files: [a, a] }, 1: { kind: 'mask', files: [f('m.png', 'kept')] } }))
      .toEqual([a, f('m.png', 'kept')])
  })
  it('turns text, numbers, booleans, JSON text and addresses into the literal a typed widget would hold', () => {
    expect(literalOf({ kind: 'text', text: 'a' })).toBe('a')
    expect(literalOf({ kind: 'number', value: 3, int: true })).toBe(3)
    expect(literalOf({ kind: 'boolean', value: false })).toBe(false)
    expect(literalOf({ kind: 'json', text: '[1, 2]' })).toBe('[1, 2]')
    expect(literalOf({ kind: 'glb', url: '/view?filename=m.glb&type=output', file: null })).toBe('/view?filename=m.glb&type=output')
    expect(literalOf({ kind: 'files', files: [] })).toBeUndefined()
    expect(literalOf({ kind: 'mask', files: [] })).toBeUndefined()
  })
})

describe('checkValue', () => {
  it('refuses text over the limit and numbers JSON cannot keep', () => {
    expect(() => checkValue({ kind: 'text', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS) })).not.toThrow()
    expect(() => checkValue({ kind: 'text', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS + 1) })).toThrow(VALUE_TOO_LONG)
    expect(() => checkValue({ kind: 'json', text: 'x'.repeat(MAX_VALUE_TEXT_CHARS + 1) })).toThrow(VALUE_TOO_LONG)
    expect(() => checkValue({ kind: 'number', value: Number.NaN, int: false })).toThrow(VALUE_NOT_FINITE)
    expect(() => checkValue({ kind: 'number', value: Infinity, int: false })).toThrow(VALUE_NOT_FINITE)
  })
})
