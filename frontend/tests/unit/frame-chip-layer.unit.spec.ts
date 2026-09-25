// Frame's prompt chip names a layer the way the layer list and the add menu do,
// never by its internal kind (UI-copy rule; stage 4 Task 9 review I1).
import { describe, it, expect } from 'vitest'
import { frameChipLayer } from '~/lib/compositor/frameChipLayer'
import { frameSelectionLabel } from '~/lib/prompt/studioDispatch'

const none = { wiredName: () => null }
const chip = (l: any, o = none) => frameSelectionLabel([frameChipLayer(l, o)])

describe('frameChipLayer', () => {
  it('a Mosaic is "Mosaic", never its internal kind', () => {
    expect(chip({ kind: 'deal' })).toBe('Mosaic')
  })
  it('shapes use the add menu’s words', () => {
    expect(chip({ kind: 'rect' })).toBe('Rectangle')
    expect(chip({ kind: 'scatter' })).toBe('Scatter')
  })
  it('a wired layer quotes its source: the slot’s own name, else the source node’s', () => {
    expect(chip({ kind: 'wired', slot: 2 }, { wiredName: (s: number) => (s === 2 ? 'Hero shot' : null) })).toBe('Hero shot')
  })
  it('a wired layer with no source name falls back to its slot, as the layer list does', () => {
    expect(chip({ kind: 'wired', slot: 0 })).toBe('Layer 1')
  })
  it('the user’s own layer name and a text layer’s words still win', () => {
    expect(chip({ kind: 'deal', name: 'Backdrop' })).toBe('Backdrop')
    expect(chip({ kind: 'text', text: 'Summer sale' })).toBe('“Summer sale” · text')
  })
})
