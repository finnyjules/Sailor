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

describe('mergeOwned — unique ids (C2)', () => {
  it('a new piece whose id is taken by an edited (no longer owned) layer gets a fresh id', () => {
    const edited = { ...rule('rule-0', 'layout-rule-0'), owner: undefined }
    const out = mergeOwned([user, edited], [rule('rule-0', 'layout-rule-0'), rule('rule-1', 'layout-rule-0-2')])
    const ids = out.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['u1', 'layout-rule-0', 'layout-rule-0-2', 'layout-rule-0-2-2'])
    expect((out[2] as any).owner.key).toBe('rule-0')
  })
})

describe('undo / redo restore the layout record (M1)', () => {
  it('an undo of an apply puts back the previous layout and variation; picker settings are not rewound', () => {
    const { node, ed } = makeEditor([createRectLayer({ id: 'r' })])
    const props = node.data.properties as any
    props.sailor_posterState = { patternId: 'runoff', seed: 1, choice: { lines: 0, arr: 0, scale: 'full', side: 'right' }, index: 0, shapeMode: null }
    ed.recordHistory()                                        // the apply's undo step
    ed.commit([createRectLayer({ id: 'r', x: 0.2 })])
    props.sailor_posterState = { ...props.sailor_posterState, patternId: 'index', seed: 9, index: 3, roles: { title: 't' } }
    props.sailor_posterState.shapeMode = { id: 'circle' }    // a picker setting, changed after
    ed.undo()
    expect(props.sailor_posterState).toMatchObject({ patternId: 'runoff', seed: 1, index: 0, shapeMode: { id: 'circle' } })
    expect(props.sailor_posterState.roles).toBeUndefined()
    ed.redo()
    expect(props.sailor_posterState).toMatchObject({ patternId: 'index', seed: 9, index: 3, roles: { title: 't' }, shapeMode: { id: 'circle' } })
  })

  it('fix wave I7: an undo of a Performance apply puts back the stored style; a redo brings it back', () => {
    const { node, ed } = makeEditor([createRectLayer({ id: 'r' })])
    const props = node.data.properties as any
    props.sailor_posterState = { patternId: 'runoff', seed: 1, choice: { lines: 0, arr: 0, scale: 'full', side: 'right' }, index: 0, style: 'swiss' }
    ed.recordHistory()                                        // the apply's undo step
    ed.commit([createRectLayer({ id: 'r', x: 0.2 })])
    // …then the tab remembers what it applied (outside the undo step), the style with it.
    props.sailor_posterState = { ...props.sailor_posterState, patternId: 'perfOffer', seed: 4209, index: 0, style: 'performance' }
    ed.undo()
    expect(props.sailor_posterState).toMatchObject({ patternId: 'runoff', style: 'swiss' })
    ed.redo()
    expect(props.sailor_posterState).toMatchObject({ patternId: 'perfOffer', style: 'performance' })
    // A Frame whose first apply was Performance: undo leaves no style behind.
    const fresh = makeEditor([createRectLayer({ id: 'r' })])
    const fp = fresh.node.data.properties as any
    fresh.ed.recordHistory()
    fresh.ed.commit([createRectLayer({ id: 'r', x: 0.3 })])
    fp.sailor_posterState = { patternId: 'perfOffer', seed: 4209, index: 0, style: 'performance' }
    fresh.ed.undo()
    expect(fp.sailor_posterState?.style).toBeUndefined()
  })

  it('a Frame that never had a layout gets no posterState from an undo', () => {
    const { node, ed } = makeEditor([createRectLayer({ id: 'r' })])
    ed.recordHistory()
    ed.commit([createRectLayer({ id: 'r', x: 0.2 })])
    ed.undo()
    expect((node.data.properties as any).sailor_posterState).toBeUndefined()
  })
})
