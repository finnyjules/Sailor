import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Pins } from '~/lib/frame/responsive/types'

describe('pins field', () => {
  it('a layer created today carries no pins (automatic)', () => {
    expect(createRectLayer().pins).toBeUndefined()
    expect(createTextLayer().pins).toBeUndefined()
  })
  it('pins are plain data on a layer and on a group', () => {
    const pins: Pins = { h: 'right', v: 'bottom', keepSize: true }
    const l = createRectLayer({ pins })
    expect(l.pins).toEqual(pins)
    const g: LayerGroup = { id: 'g1', pins: { h: 'both' } }
    expect(g.pins?.h).toBe('both')
  })
})
