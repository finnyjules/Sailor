import { describe, it, expect, vi } from 'vitest'
import { useLayoutSheet } from '~/composables/useLayoutSheet'
import { fittingPatterns } from '~/lib/frame/patterns/catalog'
import { buildFrameContext } from '~/lib/frame/patterns/frameContext'

const title = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#112233', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
const img = { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 }
function harness(extra: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = { sailor_localLayers: [title, img], ...extra }
  const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() }
  const remember = vi.fn()
  const sheet = useLayoutSheet({ props: () => props, frameW: () => 800, frameH: () => 1000, connectedSlots: () => [], editor: () => editor, remember })
  return { props, editor, remember, sheet }
}

describe('useLayoutSheet', () => {
  it('shows one tile per fitting pattern, each carrying a plan, at the remembered seed', () => {
    const { sheet, props } = harness({ sailor_posterState: { patternId: 'runoff', seed: 5 } })
    expect(sheet.seed.value).toBe(5)
    const ctx = buildFrameContext(props, 800, 1000, (t) => t.length * 60)
    expect(sheet.tiles.value.map(t => t.patternId)).toEqual(fittingPatterns(ctx).map(p => p.id))
    for (const t of sheet.tiles.value) { expect(t.plan.layers.length).toBeGreaterThan(0); expect(t.seed).toBe(5) }
  })
  it('another() bumps the seed and changes at least one tile\'s plan', () => {
    const { sheet } = harness()
    const before = JSON.stringify(sheet.tiles.value.map(t => t.plan.layers))
    sheet.another()
    expect(sheet.seed.value).toBe(2)
    expect(JSON.stringify(sheet.tiles.value.map(t => t.plan.layers))).not.toBe(before)
  })
  it('moreLikeThis() focuses one pattern with six variant seeds; back() returns to the sheet', () => {
    const { sheet } = harness()
    const first = sheet.tiles.value[0]!
    sheet.moreLikeThis(first)
    expect(sheet.focus.value).toBe(first.patternId)
    expect(sheet.tiles.value).toHaveLength(6)
    expect(sheet.tiles.value.every(t => t.patternId === first.patternId)).toBe(true)
    expect(new Set(sheet.tiles.value.map(t => t.seed)).size).toBe(6)
    sheet.back()
    expect(sheet.focus.value).toBeNull()
    expect(sheet.tiles.value.length).toBeGreaterThan(1)
  })
  it('apply() commits the tile\'s plan as one undo step and remembers the state', () => {
    const { sheet, editor, remember } = harness()
    const tile = sheet.tiles.value[0]!
    sheet.apply(tile)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit).toHaveBeenCalledTimes(1)
    expect(editor.commit.mock.calls[0][0]).toEqual(tile.plan.layers)
    expect(editor.writeOrder.mock.calls[0][0]).toEqual(tile.plan.order)
    expect(remember).toHaveBeenCalledWith({ patternId: tile.patternId, seed: tile.seed, shapeMode: undefined, imageMode: false })
  })
  it('a frame with no text has no tiles', () => {
    const { sheet } = harness({ sailor_localLayers: [img] })
    expect(sheet.tiles.value).toEqual([])
  })
  it('a set shape mode makes shape patterns fit even with no placed shape', () => {
    const { sheet } = harness()
    expect(sheet.tiles.value.map(t => t.patternId)).not.toContain('knockout')  // no shape yet
    sheet.setShapeMode({ id: 'circle' })
    expect(sheet.shapeMode.value).toEqual({ id: 'circle' })
    expect(sheet.tiles.value.map(t => t.patternId)).toContain('knockout')      // now a shape is available
  })
  it('set image mode makes image patterns fit even with no photo', () => {
    const { sheet } = harness({ sailor_localLayers: [title] })  // no image layer
    expect(sheet.tiles.value.map(t => t.patternId)).not.toContain('split')  // no photo yet
    sheet.setImageMode(true)
    expect(sheet.imageMode.value).toBe(true)
    expect(sheet.tiles.value.map(t => t.patternId)).toContain('split')      // now image patterns fit
  })
  it('a set palette recolours the tiles and applies with recolour on', () => {
    const { sheet, editor } = harness()
    const plainTitleColor = () => {
      const t = sheet.tiles.value[0]!
      const titleLayer = t.plan.layers.find(l => l.id === 't' && l.kind === 'text')
      return (titleLayer as any)?.color
    }
    const before = plainTitleColor()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])   // ink-ish / field-ish / accent
    const after = plainTitleColor()
    expect(after).not.toBe(before)                            // the palette recoloured the tile
    // apply now commits recoloured layers (title colour is the palette's, not the frame's)
    sheet.apply(sheet.tiles.value[0]!)
    const committed = editor.commit.mock.calls.at(-1)![0]
    const committedTitle = committed.find((l: any) => l.id === 't' && l.kind === 'text')
    expect(committedTitle.color).toBe(after)
  })

  it('clearing the palette returns to the frame\'s own colours (recolour off)', () => {
    const { sheet } = harness()
    const title0 = () => (sheet.tiles.value[0]!.plan.layers.find((l: any) => l.id === 't' && l.kind === 'text') as any)?.color
    const original = title0()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])
    expect(title0()).not.toBe(original)
    sheet.setPaletteMode(null)
    expect(title0()).toBe(original)                           // back to the frame's colours
  })

  it('remembers the picked palette in sailor_posterState', () => {
    const { sheet, props } = harness()
    sheet.setPaletteMode(['#0b0b0b', '#f4f1ea', '#e4572e'])
    expect((props.sailor_posterState as any).palette).toEqual(['#0b0b0b', '#f4f1ea', '#e4572e'])
  })
})
