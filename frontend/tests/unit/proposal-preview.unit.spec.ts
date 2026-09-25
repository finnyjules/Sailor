import { describe, it, expect, vi } from 'vitest'
import { edgesTouching, GhostRestores, freeInputSlot, clearRemovalMarks, removalEdgeIds, addClass, removeClass } from '~/lib/canvas/proposalPreview'

describe('edgesTouching', () => {
  it('lists edges into or out of the given nodes', () => {
    const edges = [{ id: 'a', source: '1', target: '2' }, { id: 'b', source: '2', target: '3' }, { id: 'c', source: '3', target: '4' }]
    expect(edgesTouching(edges, ['2'])).toEqual(['a', 'b'])
    expect(edgesTouching(edges, [])).toEqual([])
  })
})

describe('GhostRestores', () => {
  it('restore undoes newest first, then empties', () => {
    const order: number[] = []
    const r = new GhostRestores()
    r.push(() => order.push(1)); r.push(() => order.push(2))
    r.restore()
    expect(order).toEqual([2, 1])
    expect(r.size).toBe(0)
  })
  it('clear keeps the edits (Approve)', () => {
    const fn = vi.fn()
    const r = new GhostRestores()
    r.push(fn); r.clear(); r.restore()
    expect(fn).not.toHaveBeenCalled()
  })
  it('one failing undo does not stop the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = vi.fn()
    const r = new GhostRestores()
    r.push(ok); r.push(() => { throw new Error('x') })
    r.restore()
    expect(ok).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// A proposed rewire into an input that already has a wire (spec §3.2): the old
// wire is only MARKED while the proposal is pending. Reject keeps it; Approve drops it.
describe('freeInputSlot — a proposed rewire', () => {
  type E = { id: string; source: string; target: string; targetHandle: string; data?: any }
  const graph = (): E[] => [
    { id: 'old', source: '1', target: '3', targetHandle: 'input-0', data: { dataType: 'IMAGE' } },
    { id: 'other', source: '1', target: '3', targetHandle: 'input-1', data: { dataType: 'IMAGE' } },
  ]
  const previewRewire = (edges: E[]): E[] => {
    const kept = freeInputSlot(edges, '3', 'input-0', true)
    return [...kept, { id: 'new-ghost', source: '2', target: '3', targetHandle: 'input-0', data: { dataType: 'IMAGE', ghost: true } }]
  }

  it('a real wire drops the old edge at once', () => {
    expect(freeInputSlot(graph(), '3', 'input-0', false).map(e => e.id)).toEqual(['other'])
  })

  it('a ghost wire marks the old edge instead of removing it', () => {
    const edges = previewRewire(graph())
    expect(edges.map(e => e.id)).toEqual(['old', 'other', 'new-ghost'])
    expect(edges.find(e => e.id === 'old')!.data.removal).toBe(true)
    expect(edges.find(e => e.id === 'other')!.data.removal).toBeUndefined()
    expect(removalEdgeIds(edges)).toEqual(['old'])
  })

  it('a second ghost wire into the same slot replaces the first ghost, not the real edge', () => {
    const edges = freeInputSlot(previewRewire(graph()), '3', 'input-0', true)
    expect(edges.map(e => e.id)).toEqual(['old', 'other'])
    expect(removalEdgeIds(edges)).toEqual(['old'])
  })

  it('Reject: the old edge is still there, unmarked', () => {
    let edges = previewRewire(graph())
    edges = edges.filter(e => !e.data?.ghost) // agentDiscard drops ghosts…
    clearRemovalMarks(edges) // …and clears the marks
    expect(edges.map(e => e.id)).toEqual(['old', 'other'])
    expect(removalEdgeIds(edges)).toEqual([])
    expect(edges.find(e => e.id === 'old')!.data).toEqual({ dataType: 'IMAGE', removal: false })
  })

  it('Approve: the old edge is gone and the new one is real', () => {
    let edges = previewRewire(graph())
    for (const e of edges) if (e.data?.ghost) e.data.ghost = false // agentCommit promotes…
    const drop = new Set(removalEdgeIds(edges)) // …then removes the marked edges
    edges = edges.filter(e => !drop.has(e.id))
    expect(edges.map(e => e.id)).toEqual(['other', 'new-ghost'])
    expect(edges.find(e => e.id === 'new-ghost')!.data.ghost).toBe(false)
  })
})

describe('addClass / removeClass', () => {
  it('adds without replacing, once', () => {
    expect(addClass(undefined, 'agent-removal')).toBe('agent-removal')
    expect(addClass('agent-takes-target', 'agent-removal')).toBe('agent-takes-target agent-removal')
    expect(addClass('agent-removal', 'agent-removal')).toBe('agent-removal')
  })
  it('removes only that class', () => {
    expect(removeClass('agent-takes-target agent-removal', 'agent-removal')).toBe('agent-takes-target')
    expect(removeClass('agent-removal', 'agent-removal')).toBeUndefined()
    expect(removeClass(undefined, 'agent-removal')).toBeUndefined()
  })
})
