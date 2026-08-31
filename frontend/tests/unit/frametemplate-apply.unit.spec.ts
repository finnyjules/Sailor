import { describe, it, expect } from 'vitest'
import { placeTemplate } from '~/lib/frametemplate/apply'
import type { Template } from '~/lib/frametemplate/types'

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
})
