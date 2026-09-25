import { describe, it, expect, vi } from 'vitest'
import { edgesTouching, GhostRestores } from '~/lib/canvas/proposalPreview'

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
