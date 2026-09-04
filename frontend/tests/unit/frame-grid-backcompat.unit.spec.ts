import { describe, it, expect } from 'vitest'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid } from '~/lib/frame/grid'

// A frame saved before the grid feature has no `sailor_localGrid` property.
// It must load with the grid OFF and contribute nothing to layout or snapping,
// so existing frames render byte-identically.
describe('grid backward-compat: off by default', () => {
  it('a pre-grid frame reads mode off', () => {
    expect(readGrid({ sailor_localLayers: [], sailor_background: '#fff' }).mode).toBe('off')
    expect(readGrid(undefined).mode).toBe('off')
  })
  it('an off grid yields no lines or regions, so no snap targets', () => {
    const g = readGrid({})               // off
    const { xs, ys, regions } = resolveGrid(g, 1200, 800)
    expect(xs).toEqual([])
    expect(ys).toEqual([])
    expect(regions).toEqual([])
    // the editor passes xs.map(x=>x/W) as gridX — empty in, empty out
    expect(xs.map(x => x / 1200)).toEqual([])
  })
})
