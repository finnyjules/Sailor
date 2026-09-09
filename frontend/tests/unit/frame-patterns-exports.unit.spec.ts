import { describe, it, expect } from 'vitest'
import { cssFontStack, transformCase } from '~/composables/useCompositorLayers'

describe('exported helpers the poster bridge relies on', () => {
  it('cssFontStack is exported and yields the renderer stack shape', () => {
    expect(cssFontStack('Inter')).toBe('Inter, sans-serif')
    expect(cssFontStack('Inter Tight')).toBe('"Inter Tight", sans-serif')   // spaces get quoted
  })
  it('transformCase is exported and applies the display case', () => {
    expect(transformCase('noise', 'uppercase')).toBe('NOISE')
    expect(transformCase('Noise', undefined)).toBe('Noise')
  })
})
