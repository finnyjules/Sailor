import { describe, it, expect } from 'vitest'
import { snapshotFrameAsTemplate, addSlot, removeSlot } from '~/lib/frametemplate/author'

const textLayer = (id: string, text: string) => ({ id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text, color: '#fff' } as any)

describe('snapshotFrameAsTemplate', () => {
  it('assigns a stable key to every layer and copies deeply (no aliasing)', () => {
    const layers = [textLayer('ll-a', 'Hi'), textLayer('ll-b', 'Yo')]
    const t = snapshotFrameAsTemplate({ id: 'tpl1', name: 'Two lines', layers, groups: [], frameSize: { w: 1920, h: 1080 }, mkKey: (i) => `k${i}` })
    expect(t.layers.map(l => l.key)).toEqual(['k0', 'k1'])
    expect(t.version).toBe(1)
    layers[0].text = 'MUTATED'
    expect(t.layers[0].layer.text).toBe('Hi') // deep copy, not a reference
  })
})

describe('addSlot / removeSlot', () => {
  it('adds a slot referencing a layer key, then removes it', () => {
    const layers = [textLayer('ll-a', 'Hi')]
    let t = snapshotFrameAsTemplate({ id: 'tpl1', name: 'x', layers, groups: [], frameSize: { w: 100, h: 100 }, mkKey: (i) => `k${i}` })
    t = addSlot(t, 'k0', 'text', 'Headline', () => 'slot0')
    expect(t.slots).toEqual([{ id: 'slot0', layerKey: 'k0', kind: 'text', label: 'Headline' }])
    t = removeSlot(t, 'slot0')
    expect(t.slots).toEqual([])
  })
})
