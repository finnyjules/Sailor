// A new Frame is born with a shown layout grid (fix round 1): layers that arrive before the editor
// opens — the card's Edit here, a template, a start-modal pick, a sent set entry — must not get it
// classed as an old Frame. An old Frame (layers, no stored grid) still reads hidden.
import { describe, it, expect } from 'vitest'
import { stampNewFrameGrid, newFrameLayoutGrid } from '~/lib/frame/newFrameGrid'
import { readLayoutGrid, patchLayoutGrid } from '~/lib/frame/layoutGrid'
import { sentFrameData } from '~/lib/frame/layoutSetSend'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const frameData = (properties: Record<string, any> = {}) =>
  ({ widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [1080, 1350], properties }) as any
const layer = { id: 't1', kind: 'text', text: 'Hi', x: 0.5, y: 0.5 }

describe('a new Frame', () => {
  it('is stamped with a shown auto grid, and still reads shown once layers land', () => {
    const d = frameData()
    stampNewFrameGrid(d)
    expect(d.properties.sailor_layoutGrid).toMatchObject({ v: 2, auto: true, show: true })
    d.properties.sailor_localLayers = [layer]            // e.g. added on the card, or by a template
    expect(readLayoutGrid(d.properties, 1080, 1350, null).show).toBe(true)
  })
  it('a Frame created with no properties object gets one', () => {
    const d = { widgetDefs: [], widgetsValues: [] } as any
    stampNewFrameGrid(d)
    expect(d.properties.sailor_layoutGrid.show).toBe(true)
  })
  it('never overwrites a grid the node already carries', () => {
    const own = patchLayoutGrid(newFrameLayoutGrid(frameData()), { columns: 5, show: false })
    const d = frameData({ sailor_layoutGrid: own })
    stampNewFrameGrid(d)
    expect(d.properties.sailor_layoutGrid).toBe(own)
  })
  it('an old Frame (layers, no stored grid) still reads hidden', () => {
    expect(readLayoutGrid({ sailor_localLayers: [layer] }, 1080, 1350, null).show).toBe(false)
  })
})

describe('a Frame sent from a set', () => {
  function entry(formatId: string): SetEntry {
    const f = FRAME_FORMATS.find(x => x.id === formatId)!
    const layers = [layer] as unknown as LocalLayer[]
    return {
      formatId, label: f.label, w: f.w, h: f.h, layoutId: 'edCover', layoutName: 'Cover', swapped: false,
      choice: {} as never,
      plan: { layers, order: ['l:t1'], did: '', issues: [], posterState: { patternId: 'edCover', seed: 1, choice: {} as never, roles: {} as never }, format: null, notPlaced: [] } as unknown as SetEntry['plan'],
      layers,
    } as SetEntry
  }
  it('gets a shown auto grid for its own size, even from an old source with no grid', () => {
    const src = { nodeType: 'Compositor', ...frameData({ sailor_frame: { preset: 'meta-feed-4x5' }, sailor_localLayers: [layer] }) }
    const d = sentFrameData(src, entry('meta-story'))!
    expect(d.properties.sailor_layoutGrid).toMatchObject({ v: 2, auto: true, show: true })
    expect(readLayoutGrid(d.properties, 1080, 1920, null).show).toBe(true)
  })
  it('a user grid does not travel to the new size; hiding it does', () => {
    const own = patchLayoutGrid(newFrameLayoutGrid(frameData()), { columns: 5, show: false })
    const src = { nodeType: 'Compositor', ...frameData({ sailor_frame: { preset: 'meta-feed-4x5' }, sailor_localLayers: [layer], sailor_layoutGrid: own }) }
    const d = sentFrameData(src, entry('meta-story'))!
    expect(d.properties.sailor_layoutGrid).toMatchObject({ auto: true, show: false })
  })
})
