import { describe, it, expect } from 'vitest'
import { layoutKeyAction } from '~/lib/frame/layoutKeys'
import type { LayoutKeyState } from '~/lib/frame/layoutKeys'

const key = (k: string, over: Partial<KeyboardEvent> = {}) =>
  ({ key: k, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })
const on: LayoutKeyState = { tabVisible: true, inTextField: false, editingText: false, selectionEmpty: true }

describe('layoutKeyAction', () => {
  it('V steps forward on the Layout tab, with or without a selection', () => {
    expect(layoutKeyAction(key('v'), on)).toBe('next')
    expect(layoutKeyAction(key('V'), on)).toBe('next')
    expect(layoutKeyAction(key('v'), { ...on, selectionEmpty: false })).toBe('next')
  })
  it('the arrows step only with nothing selected; with a selection they are left to nudge', () => {
    expect(layoutKeyAction(key('ArrowRight'), on)).toBe('next')
    expect(layoutKeyAction(key('ArrowLeft'), on)).toBe('prev')
    expect(layoutKeyAction(key('ArrowRight'), { ...on, selectionEmpty: false })).toBeNull()
    expect(layoutKeyAction(key('ArrowLeft'), { ...on, selectionEmpty: false })).toBeNull()
    expect(layoutKeyAction(key('ArrowUp'), on)).toBeNull()
    expect(layoutKeyAction(key('ArrowDown'), on)).toBeNull()
  })
  it('nothing on another tab, while typing in a field, or while editing a text layer', () => {
    for (const k of ['v', 'ArrowRight', 'ArrowLeft']) {
      expect(layoutKeyAction(key(k), { ...on, tabVisible: false })).toBeNull()
      expect(layoutKeyAction(key(k), { ...on, inTextField: true })).toBeNull()
      expect(layoutKeyAction(key(k), { ...on, editingText: true })).toBeNull()
    }
  })
  it('a modifier leaves the key to its own meaning', () => {
    for (const m of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(layoutKeyAction(key('v', { [m]: true }), on)).toBeNull()
      expect(layoutKeyAction(key('ArrowRight', { [m]: true }), on)).toBeNull()
    }
  })
  it('a held key is swallowed, not stepped', () => {
    expect(layoutKeyAction(key('v', { repeat: true }), on)).toBe('swallow')
    expect(layoutKeyAction(key('ArrowLeft', { repeat: true }), on)).toBe('swallow')
    expect(layoutKeyAction(key('ArrowLeft', { repeat: true }), { ...on, selectionEmpty: false })).toBeNull()
  })
  it('other keys are never taken', () => {
    expect(layoutKeyAction(key('b'), on)).toBeNull()
    expect(layoutKeyAction(key(' '), on)).toBeNull()
  })
})
