import { describe, it, expect } from 'vitest'
import { placeTemplate, updateInstance, slotCompatible, staleInstances } from '~/lib/frametemplate/apply'
import type { Template } from '~/lib/frametemplate/types'

const v1: Template = {
  id: 'tpl', name: 'x', version: 1,
  layers: [
    { key: 'bg', layer: { id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, fill: '#111' } as any },
    { key: 'head', layer: { id: 'b', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NAME', color: '#fff' } as any },
  ],
  groups: [], slots: [{ id: 's-head', layerKey: 'head', kind: 'text', label: 'Headline' }], frameSize: { w: 100, h: 100 },
}
const mk = () => { let n = 0; return { mkLayerId: () => `n${++n}`, mkGroupId: () => 'g', mkInstanceId: () => 'inst' } }

it('restyle flows to a copy while its slot value survives', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, v1, { 's-head': 'Julien' }, mk())
  // v2 restyles the LOCKED bg color; slots unchanged
  const v2: Template = { ...v1, version: 2, layers: [
    { key: 'bg', layer: { ...v1.layers[0].layer, fill: '#c00' } as any },
    v1.layers[1],
  ] }
  expect(slotCompatible(v2, placed.instance)).toBe(true)
  const upd = updateInstance({ layers: placed.layers, groups: [] }, v2, placed.instance, { mkLayerId: () => `u${Math.random()}`, mkGroupId: () => 'g' })
  const bg = upd.layers.find(l => l.kind === 'rect') as any
  const head = upd.layers.find(l => l.kind === 'text') as any
  expect(bg.fill).toBe('#c00')       // restyle reached the copy
  expect(head.text).toBe('Julien')   // slot value preserved
  expect(upd.instance.templateVersion).toBe(2)
})

it('a reshape (added slot) is NOT compatible and is skipped by staleInstances', () => {
  const placed = placeTemplate({ layers: [], groups: [] }, v1, { 's-head': 'Julien' }, mk())
  const v2: Template = { ...v1, version: 2, slots: [...v1.slots, { id: 's-new', layerKey: 'bg', kind: 'color', label: 'Accent' }] }
  expect(slotCompatible(v2, placed.instance)).toBe(false)
  expect(staleInstances([placed.instance], () => v2)).toEqual([])
})
