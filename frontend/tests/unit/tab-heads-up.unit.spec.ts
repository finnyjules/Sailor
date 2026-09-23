import { describe, expect, it, vi } from 'vitest'
import { createHeadsUp, headsUpTitle, BASE_TITLE, FAVICON_URL, FAVICON_DOT_URL } from '~/composables/useTabHeadsUp'

function page(hidden: boolean) {
  return { hidden, isHidden() { return this.hidden }, setTitle: vi.fn(), setIcon: vi.fn() }
}

describe('tab heads-up', () => {
  it('titles say what happened, in plain words', () => {
    expect(headsUpTitle('image')).toBe('✓ Image ready · Sailor')
    expect(headsUpTitle('video')).toBe('✓ Video ready · Sailor')
    expect(headsUpTitle('paused')).toBe('Ready to review · Sailor')
    expect(headsUpTitle('failed')).toBe('Run failed · Sailor')
  })
  it('only changes a tab you are not looking at, and clears when you come back', () => {
    const p = page(true)
    const h = createHeadsUp(p)
    h.notify('video')
    expect(p.setTitle).toHaveBeenLastCalledWith('✓ Video ready · Sailor')
    expect(p.setIcon).toHaveBeenLastCalledWith(FAVICON_DOT_URL)
    h.clear()
    expect(p.setTitle).toHaveBeenLastCalledWith(BASE_TITLE)
    expect(p.setIcon).toHaveBeenLastCalledWith(FAVICON_URL)
    const q = page(false)
    createHeadsUp(q).notify('image')
    expect(q.setTitle).not.toHaveBeenCalled()
  })
  it('clearing twice does nothing the second time', () => {
    const p = page(true)
    const h = createHeadsUp(p)
    h.clear()
    expect(p.setTitle).not.toHaveBeenCalled()
  })
})
