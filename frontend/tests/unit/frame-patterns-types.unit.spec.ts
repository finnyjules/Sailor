import { describe, it, expect } from 'vitest'
import { kindOf } from '~/lib/frame/patterns/types'

describe('kindOf', () => {
  it('classifies by word count', () => {
    expect(kindOf(1)).toBe('word')
    expect(kindOf(3)).toBe('phrase')
    expect(kindOf(4)).toBe('phrase')
    expect(kindOf(5)).toBe('sentence')
    expect(kindOf(20)).toBe('sentence')
  })
  it('treats zero as a word (empty title still classifies)', () => {
    expect(kindOf(0)).toBe('word')
  })
})
