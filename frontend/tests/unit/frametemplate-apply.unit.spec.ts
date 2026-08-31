import { describe, it, expect } from 'vitest'
import { placeTemplate, applySlotToLayer } from '~/lib/frametemplate/apply'
import type { Template } from '~/lib/frametemplate/types'

/** Fresh, uniquely-numbered ctx per call (the shared `ctx` below reuses one fixed
 *  group id across a whole call, which isn't enough to tell apart two groups). */
function mkCtx() {
  let n = 0
  return {
    mkLayerId: () => `L${++n}`,
    mkGroupId: () => `G${++n}`,
    mkInstanceId: () => `I${++n}`,
  }
}

const tpl: Template = {
  id: 'tpl1', name: 'Lower third', version: 3,
  layers: [
    { key: 'bg', layer: { id: 'x', kind: 'rect', x: 0.5, y: 0.8, rotation: 0, opacity: 1, fill: '#111' } as any },
    { key: 'head', layer: { id: 'y', kind: 'text', x: 0.5, y: 0.8, rotation: 0, opacity: 1, text: 'NAME', color: '#fff' } as any },
  ],
  groups: [], slots: [{ id: 's-head', layerKey: 'head', kind: 'text', label: 'Headline' }],
  frameSize: { w: 1920, h: 1080 },
}
const ctx = (() => { let n = 0; return { mkLayerId: () => `new-${++n}`, mkGroupId: () => 'g-new', mkInstanceId: () => 'inst-1' } })()

describe('placeTemplate', () => {
  it('materializes fresh layers, fills the slot, and records key→id + version', () => {
    const r = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'Julien' }, ctx)
    expect(r.layers).toHaveLength(2)
    // fresh ids, not the template's
    expect(r.layers.every(l => l.id.startsWith('new-'))).toBe(true)
    // slot applied to the head layer
    const head = r.layers.find(l => l.kind === 'text') as any
    expect(head.text).toBe('Julien')
    // locked layer unchanged
    const bg = r.layers.find(l => l.kind === 'rect') as any
    expect(bg.fill).toBe('#111')
    // instance records the map + the template's current version
    expect(r.instance.templateVersion).toBe(3)
    expect(r.instance.slotValues).toEqual({ 's-head': 'Julien' })
    expect(Object.keys(r.instance.placedKeys)).toEqual(['bg', 'head'])
    expect(r.instance.placedKeys.head).toBe(head.id)
  })
  it('preserves existing layers (append, not replace)', () => {
    const existing = { id: 'keep', kind: 'text', x: 0.1, y: 0.1, rotation: 0, opacity: 1, text: 'keep' } as any
    const r = placeTemplate({ layers: [existing], groups: [] }, tpl, { 's-head': 'A' }, ctx)
    expect(r.layers[0]).toBe(existing)
    expect(r.layers).toHaveLength(3)
  })

  it('remaps a layer groupId and a parent/child group pair to fresh ids', () => {
    const grouped: Template = {
      id: 'tpl-grouped', name: 'Grouped', version: 1,
      layers: [
        { key: 'bg', layer: { id: 'x', kind: 'rect', x: 0.5, y: 0.8, rotation: 0, opacity: 1, fill: '#111', groupId: 'gChild' } as any },
      ],
      groups: [
        { id: 'gParent', name: 'parent' },
        { id: 'gChild', name: 'child', parentId: 'gParent' },
      ],
      slots: [],
      frameSize: { w: 1920, h: 1080 },
    }
    const r = placeTemplate({ layers: [], groups: [] }, grouped, {}, mkCtx())
    expect(r.groups).toHaveLength(2)
    const freshParent = r.groups.find(g => g.name === 'parent')!
    const freshChild = r.groups.find(g => g.name === 'child')!
    // fresh ids, not the template's original ids
    expect(freshParent.id).not.toBe('gParent')
    expect(freshChild.id).not.toBe('gChild')
    // child's parentId remapped to the parent's fresh id
    expect(freshChild.parentId).toBe(freshParent.id)
    // the placed layer's groupId points at the child's fresh id
    expect(r.layers[0]!.groupId).toBe(freshChild.id)
  })

  it('clears a layer groupId that references a group outside the template snapshot (orphan)', () => {
    const orphan: Template = {
      id: 'tpl-orphan', name: 'Orphan', version: 1,
      layers: [
        { key: 'bg', layer: { id: 'x', kind: 'rect', x: 0.5, y: 0.8, rotation: 0, opacity: 1, fill: '#111', groupId: 'not-in-groups' } as any },
      ],
      groups: [],
      slots: [],
      frameSize: { w: 1920, h: 1080 },
    }
    const r = placeTemplate({ layers: [], groups: [] }, orphan, {}, mkCtx())
    expect(r.layers[0]!.groupId).toBeUndefined()
  })

  it('applySlotToLayer: image slot sets filename; color slot sets fill (rect) or color (text)', () => {
    const rect: any = { id: 'r', kind: 'rect', x: 0, y: 0, rotation: 0, opacity: 1, fill: '#000' }
    applySlotToLayer(rect, 'image', 'photo.png')
    expect(rect.filename).toBe('photo.png')

    const rect2: any = { id: 'r2', kind: 'rect', x: 0, y: 0, rotation: 0, opacity: 1, fill: '#000' }
    applySlotToLayer(rect2, 'color', '#ff0000')
    expect(rect2.fill).toBe('#ff0000')

    const text: any = { id: 't', kind: 'text', x: 0, y: 0, rotation: 0, opacity: 1, text: 'hi', color: '#000' }
    applySlotToLayer(text, 'color', '#00ff00')
    expect(text.color).toBe('#00ff00')
  })

  it('two placements against the same template are independent (no shared refs, no mutation)', () => {
    const before = JSON.parse(JSON.stringify(tpl.layers))
    const r1 = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'One' }, mkCtx())
    const r2 = placeTemplate({ layers: [], groups: [] }, tpl, { 's-head': 'Two' }, mkCtx())
    // no shared object references between the two placements' layers
    for (const l1 of r1.layers) {
      for (const l2 of r2.layers) {
        expect(l1).not.toBe(l2)
      }
    }
    // template's stored layers were not mutated by either placement
    expect(tpl.layers).toEqual(before)
  })
})
