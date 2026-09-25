// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { settleTakesOnRender, studioTakeId, studioTakeIndex, studioTakesSession, thumbSrc } from '~/lib/prompt/studioTakes'
import { CURRENT } from '~/lib/prompt/takesSession'

const a = { label: 'Warm' }, b = { label: 'Cool' }, c = { label: 'Dusk' }

describe('studio takes adapter', () => {
  it('no takes → no strip', () => {
    expect(studioTakesSession({ label: 'Water ripple', request: 'warmer', takes: [], thumbs: new Map(), current: null, selected: null })).toBeNull()
  })

  it('maps takes to three tiles: drawn → ready, not yet drawn → pending, failed draw → failed', () => {
    const s = studioTakesSession({
      label: 'Water ripple', request: ' warmer ', takes: [a, b, c],
      thumbs: new Map<any, any>([[a, 'data:a'], [c, null]]), current: 'data:cur', selected: null,
    })!
    expect(s.nodeLabel).toBe('Water ripple')
    expect(s.request).toBe('warmer')
    expect(s.currentThumb).toBe('data:cur')
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'failed'])
    expect(s.tiles[0]).toEqual({ state: 'ready', takeId: 'take-0', promptId: null, thumb: 'data:a' })
    expect(s.tiles[1]!.takeId).toBe('take-1')
  })

  it('two takes leave the third tile failed; more than three are cut to three', () => {
    const two = studioTakesSession({ label: 'x', request: '', takes: [a, b], thumbs: new Map<any, any>([[a, 'u'], [b, 'v']]), current: null, selected: null })!
    expect(two.tiles.map(t => t.state)).toEqual(['ready', 'ready', 'failed'])
    const four = studioTakesSession({ label: 'x', request: '', takes: [a, b, c, { label: 'd' }], thumbs: new Map(), current: null, selected: null })!
    expect(four.tiles).toHaveLength(3)
  })

  it('the selected take is the chosen tile; none selected means the current version', () => {
    const s = studioTakesSession({ label: 'x', request: '', takes: [a, b], thumbs: new Map(), current: null, selected: b })!
    expect(s.chosen).toBe('take-1')
    expect(studioTakesSession({ label: 'x', request: '', takes: [a], thumbs: new Map(), current: null, selected: null })!.chosen).toBe(CURRENT)
  })

  it('ids round-trip, and anything else is not a take', () => {
    expect(studioTakeIndex(studioTakeId(2))).toBe(2)
    expect(studioTakeIndex(CURRENT)).toBeNull()
    expect(studioTakeIndex(null)).toBeNull()
    expect(studioTakeIndex('take-x')).toBeNull()
  })

  it('a canvas thumbnail becomes a data URL; empty and null are no picture', () => {
    const cv = document.createElement('canvas')
    ;(cv as any).toDataURL = () => 'data:image/png;base64,AAA'
    expect(thumbSrc(cv)).toBe('data:image/png;base64,AAA')
    expect(thumbSrc('')).toBeNull()
    expect(thumbSrc(null)).toBeNull()
    expect(thumbSrc(undefined)).toBeNull()
  })
})

describe('settleTakesOnRender', () => {
  const agent = (open: boolean, picked: unknown) => ({
    hasTakes: { value: open }, selectedTake: { value: picked }, keepTake: vi.fn(), abandonTakes: vi.fn(),
  })
  it('keeps the picked take (what was rendered)', () => {
    const a = agent(true, { label: 'b' })
    settleTakesOnRender(a)
    expect(a.keepTake).toHaveBeenCalledTimes(1)
    expect(a.abandonTakes).not.toHaveBeenCalled()
  })
  it('abandons an open strip when the original was on screen', () => {
    const a = agent(true, null)
    settleTakesOnRender(a)
    expect(a.abandonTakes).toHaveBeenCalledTimes(1)
    expect(a.keepTake).not.toHaveBeenCalled()
  })
  it('does nothing with no strip, or no take support', () => {
    const a = agent(false, null)
    settleTakesOnRender(a)
    settleTakesOnRender({})
    settleTakesOnRender(null)
    expect(a.keepTake).not.toHaveBeenCalled()
    expect(a.abandonTakes).not.toHaveBeenCalled()
  })
})
