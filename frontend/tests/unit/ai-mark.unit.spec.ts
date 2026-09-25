// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AiMark from '~/components/prompt/AiMark.vue'

const PASTEL = ['#ffd6e7', '#cfe8ff', '#d6ffe0', '#fff4cc', '#e7d6ff']

describe('AiMark', () => {
  it('fills the sparkles with the pastel gradient', () => {
    const w = mount(AiMark)
    const grad = w.get('linearGradient')
    expect(grad.findAll('stop').map(s => s.attributes('stop-color'))).toEqual(PASTEL)
    const id = grad.attributes('id')!
    expect(w.get('path[data-part="star"]').attributes('fill')).toBe(`url(#${id})`)
  })
  it('draws a single four-point star for the "star" kind', () => {
    const w = mount(AiMark, { props: { kind: 'star' } })
    expect(w.findAll('path')).toHaveLength(1)
    expect(w.get('path').attributes('fill')).toMatch(/^url\(#/)
  })
  it('gives each instance on a page its own gradient id', () => {
    const w = mount({ components: { AiMark }, template: '<div><AiMark /><AiMark kind="star" /></div>' })
    const ids = w.findAll('linearGradient').map(g => g.attributes('id'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
  it('is decorative', () => {
    expect(mount(AiMark).get('svg').attributes('aria-hidden')).toBe('true')
  })
})
