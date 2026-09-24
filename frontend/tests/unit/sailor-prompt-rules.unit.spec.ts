import { describe, it, expect } from 'vitest'
import { promptPlaceholder, escapeStep, isEditableTarget, shouldFocusPrompt } from '~/lib/prompt/sailorPrompt'

const key = (k: string, o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...o })

describe('promptPlaceholder', () => {
  it('asks Sailor with nothing selected', () => expect(promptPlaceholder(null)).toBe('Ask Sailor'))
  it('quotes the selection', () => expect(promptPlaceholder('Rainy shop')).toBe('Change or ask about Rainy shop'))
  it('treats a blank label as nothing selected', () => expect(promptPlaceholder('  ')).toBe('Ask Sailor'))
})

describe('escapeStep', () => {
  it('clears the mode first on an empty field', () => expect(escapeStep({ text: '', mode: 'Remix' })).toBe('clearMode'))
  it('leaves the field when there is text', () => expect(escapeStep({ text: 'rain', mode: 'Remix' })).toBe('blur'))
  it('leaves the field when there is no mode', () => expect(escapeStep({ text: '', mode: null })).toBe('blur'))
})

describe('isEditableTarget', () => {
  it('knows inputs, textareas, selects and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('shouldFocusPrompt', () => {
  it('focuses on / outside a field', () => expect(shouldFocusPrompt(key('/'))).toBe(true))
  it('ignores / while typing in a field', () => expect(shouldFocusPrompt(key('/', { target: { tagName: 'INPUT' } }))).toBe(false))
  it('ignores / with a modifier', () => expect(shouldFocusPrompt(key('/', { metaKey: true }))).toBe(false))
  it('focuses on ⌘K and Ctrl+K, even from a field', () => {
    expect(shouldFocusPrompt(key('k', { metaKey: true }))).toBe(true)
    expect(shouldFocusPrompt(key('K', { ctrlKey: true, target: { tagName: 'INPUT' } }))).toBe(true)
  })
  it('ignores ⌥⌘K and plain k', () => {
    expect(shouldFocusPrompt(key('k', { metaKey: true, altKey: true }))).toBe(false)
    expect(shouldFocusPrompt(key('k'))).toBe(false)
  })
})
