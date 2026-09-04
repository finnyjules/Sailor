import { describe, it, expect } from 'vitest'
import { edgeTopologyKey } from '~/lib/canvas/edgeTopologyKey'

// The canvas' edge watchers (ShotDirector cast sync, Collection-link prune) only
// care about edge TOPOLOGY — which node/handle connects to which. They used to
// run on a `{ deep: true }` watch of `edges`, which re-traverses every edge's
// `sourceNode`/`targetNode` back-references (i.e. the whole graph) on every node
// position change during a drag. This key is the cheap replacement: it must
// change for every topology change and for nothing else.

const e = (over: Record<string, unknown> = {}) => ({ id: 'e1', source: 'a', target: 'b', ...over })

describe('edgeTopologyKey', () => {
  it('returns an empty string for no edges', () => {
    expect(edgeTopologyKey([])).toBe('')
  })

  it('changes when an edge is added', () => {
    const before = [e()]
    const after = [e(), e({ id: 'e2', source: 'b', target: 'c' })]
    expect(edgeTopologyKey(after)).not.toBe(edgeTopologyKey(before))
  })

  it('changes when an edge is removed', () => {
    const before = [e(), e({ id: 'e2', source: 'b', target: 'c' })]
    const after = [e()]
    expect(edgeTopologyKey(after)).not.toBe(edgeTopologyKey(before))
  })

  it('changes when an edge is rewired to a different target', () => {
    expect(edgeTopologyKey([e({ target: 'c' })])).not.toBe(edgeTopologyKey([e()]))
  })

  it('changes when an edge is rewired to a different source', () => {
    expect(edgeTopologyKey([e({ source: 'z' })])).not.toBe(edgeTopologyKey([e()]))
  })

  it('changes when a source handle changes', () => {
    expect(edgeTopologyKey([e({ sourceHandle: 'out-1' })]))
      .not.toBe(edgeTopologyKey([e({ sourceHandle: 'out-2' })]))
  })

  it('changes when a target handle changes', () => {
    expect(edgeTopologyKey([e({ targetHandle: 'images' })]))
      .not.toBe(edgeTopologyKey([e({ targetHandle: 'mask' })]))
  })

  it('treats a missing handle and a null handle the same', () => {
    expect(edgeTopologyKey([e({ sourceHandle: null, targetHandle: null })]))
      .toBe(edgeTopologyKey([e()]))
  })

  it('is unchanged by data, selection, or the sourceNode/targetNode back-references', () => {
    const plain = edgeTopologyKey([e()])
    const fat = edgeTopologyKey([e({
      data: { dataType: 'IMAGE', label: 'changed' },
      selected: true,
      animated: true,
      style: { stroke: 'red' },
      sourceNode: { id: 'a', position: { x: 10, y: 20 }, data: { properties: { seed: 7 } } },
      targetNode: { id: 'b', position: { x: 99, y: 40 }, data: { properties: { seed: 8 } } },
    })])
    expect(fat).toBe(plain)
  })

  it('is unchanged when only node positions move (the drag case)', () => {
    const at = (x: number) => edgeTopologyKey([e({
      sourceNode: { id: 'a', position: { x, y: 0 }, computedPosition: { x, y: 0 } },
      targetNode: { id: 'b', position: { x: x + 200, y: 0 } },
    })])
    expect(at(300)).toBe(at(0))
  })

  it('stringifies numeric and string ids the same', () => {
    expect(edgeTopologyKey([{ id: 1, source: 2, target: 3 }]))
      .toBe(edgeTopologyKey([{ id: '1', source: '2', target: '3' }]))
  })

  it('depends on array order', () => {
    const a = e({ id: 'e1', source: 'a', target: 'b' })
    const b = e({ id: 'e2', source: 'b', target: 'c' })
    expect(edgeTopologyKey([a, b])).not.toBe(edgeTopologyKey([b, a]))
  })

  it('separates edges so a boundary shift still changes the key', () => {
    // Guards against a delimiter-free join where "ab|c" and "a|bc" collide.
    expect(edgeTopologyKey([{ id: 'e', source: 'ab', target: 'c' }]))
      .not.toBe(edgeTopologyKey([{ id: 'e', source: 'a', target: 'bc' }]))
  })
})
