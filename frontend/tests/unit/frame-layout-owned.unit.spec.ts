import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { mergeOwned, isOwned } from '~/lib/frame/patterns/kit/owned'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

const user = { id: 'u1', kind: 'text', text: 'Hi' } as any
const rule = (key: string, id: string, x = 0.5) =>
  ({ id, kind: 'rect', x, y: 0.5, w: 0.2, h: 0.001, owner: { by: 'layout', key } }) as any

describe('mergeOwned', () => {
  it('removes owned pieces the new plan does not want, keeps user layers', () => {
    const out = mergeOwned([user, rule('rule-0', 'a'), rule('rule-1', 'b')], [rule('rule-0', 'new', 0.3)])
    expect(out.map(l => l.id)).toEqual(['u1', 'a'])
    expect(out[1].x).toBe(0.3) // updated in place, id kept
  })

  it('appends new keys', () => {
    const out = mergeOwned([user], [rule('band', 'z')])
    expect(out.map(l => l.id)).toEqual(['u1', 'z'])
  })

  it('never removes a layer whose owner was cleared by an edit', () => {
    const edited = { ...rule('rule-0', 'a'), owner: undefined }
    expect(mergeOwned([user, edited], []).map(l => l.id)).toEqual(['u1', 'a'])
  })
})

describe('isOwned', () => {
  it('is true only for layout-owned layers', () => {
    expect(isOwned(rule('rule-0', 'a'))).toBe(true)
    expect(isOwned(user)).toBe(false)
    expect(isOwned({ owner: undefined })).toBe(false)
  })
})

// ── Editor: a user edit strips ownership ─────────────────────────────────────
function fixtureNode(layers: any[]) {
  return reactive({ data: { widgetDefs: [], widgetsValues: [], properties: { sailor_localLayers: layers } } })
}

function makeEditor(layers: any[]) {
  const node = fixtureNode(layers)
  const ed = useLocalLayerEditor({
    node: () => node,
    dims: () => ({ w: 1024, h: 1024 }),
    getRect: () => null,
  })
  return { node, ed }
}

describe('user edits clear owner', () => {
  it('setLocal on an owned layer commits it without owner', () => {
    const owned = createRectLayer({ owner: { by: 'layout', key: 'rule-0' } })
    const { node, ed } = makeEditor([owned])
    ed.setLocal(owned.id, { x: 0.2 })
    const committed = (node.data.properties.sailor_localLayers as any[])[0]
    expect(committed.x).toBe(0.2)
    expect(committed.owner).toBeUndefined()
  })

  it('a keyboard nudge on an owned layer clears owner', () => {
    const owned = createRectLayer({ owner: { by: 'layout', key: 'rule-0' }, x: 0.5, y: 0.5 })
    const { node, ed } = makeEditor([owned])
    ed.selectLocal(owned.id)
    ed.handleEditorKey({ key: 'ArrowRight', shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {} } as any)
    const committed = (node.data.properties.sailor_localLayers as any[])[0]
    expect(committed.owner).toBeUndefined()
  })
})

describe('copies of an owned piece belong to the user', () => {
  it('duplicate drops owner on the copy, keeps it on the original', async () => {
    const { duplicateLayers } = await import('~/lib/compositor/layerEdits')
    const src = rule('band', 'a')
    const r = duplicateLayers([src], [], new Set(['a']), 0.02, () => 'd1', () => 'g1')
    expect(r.layers.find(l => l.id === 'a')!.owner).toEqual({ by: 'layout', key: 'band' })
    expect(r.layers.find(l => l.id === 'd1')!.owner).toBeUndefined()
  })

  it('paste drops owner on the pasted piece', async () => {
    const { materializePaste } = await import('~/lib/compositor/layerClipboard')
    const r = (materializePaste as any)({ layers: [rule('band', 'a')], groups: [] }, [], [], 0.02, () => 'p1', () => 'g1')
    expect(r.layers.find((l: any) => l.id === 'p1')!.owner).toBeUndefined()
  })
})
