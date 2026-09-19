import { describe, it, expect } from 'vitest'
import { mergeCompositorState } from '~/lib/agent/mergeCompositorState'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'

const L = (id: string, x = 0.5, extra: Record<string, unknown> = {}) => ({ id, kind: 'rect', x, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.2, fill: '#fff', ...extra }) as any
const S = (layers: any[], extra: Partial<CompositorState> = {}): CompositorState => ({ layers, ...extra })

describe('mergeCompositorState — apply the agent\'s delta onto the CURRENT doc', () => {
  it('no edits since the agent\'s last push → exactly the agent\'s state (unchanged behaviour)', () => {
    const base = S([L('a'), L('b')], { background: '#000' })
    const next = S([L('a', 0.1), L('b'), L('c')], { background: '#111' })
    expect(mergeCompositorState(base, base, next)).toEqual(next)
  })
  it('a layer the user moved meanwhile survives an accept that touches a DIFFERENT layer', () => {
    const base = S([L('a'), L('b')])
    const current = S([L('a'), L('b', 0.9)])                 // user dragged b
    const next = S([L('a', 0.1), L('b')])                    // agent moved a
    expect(mergeCompositorState(current, base, next).layers).toEqual([L('a', 0.1), L('b', 0.9)])
  })
  it('a layer the user ADDED meanwhile survives; a layer the agent added lands too', () => {
    const base = S([L('a')])
    const current = S([L('a'), L('u')])
    const next = S([L('a'), L('g')])
    expect(mergeCompositorState(current, base, next).layers.map((l) => l.id)).toEqual(['a', 'u', 'g'])
  })
  it('reject / revert removes what the agent added and restores what it changed — and nothing else', () => {
    const original = S([L('a'), L('b')])
    const pushed = S([L('a', 0.1), L('b'), L('g')])          // what the agent last applied
    const current = S([L('a', 0.1), L('b', 0.9), L('g')])    // …then the user dragged b
    const out = mergeCompositorState(current, pushed, original)
    expect(out.layers).toEqual([L('a'), L('b', 0.9)])
  })
  it('a layer the agent removed is removed; a layer the user deleted stays deleted', () => {
    const base = S([L('a'), L('b'), L('c')])
    const current = S([L('a'), L('c')])                      // user deleted b
    const next = S([L('a', 0.2), L('b')])                    // agent removed c, edited a
    expect(mergeCompositorState(current, base, next).layers).toEqual([L('a', 0.2)])
  })
  it('on a true conflict (both edited the same layer) the agent\'s version wins', () => {
    const base = S([L('a')])
    expect(mergeCompositorState(S([L('a', 0.9)]), base, S([L('a', 0.1)])).layers).toEqual([L('a', 0.1)])
  })
  it('an agent re-order applies; layers the user added keep a place on top', () => {
    const base = S([L('a'), L('b')])
    const current = S([L('a'), L('b'), L('u')])
    const next = S([L('b'), L('a')])
    expect(mergeCompositorState(current, base, next).layers.map((l) => l.id)).toEqual(['b', 'a', 'u'])
  })
  it('doc fields: the agent\'s value only when the agent changed it', () => {
    const base = S([], { background: '#000', postEffects: [], grid: { mode: 'off' } as any })
    const current = S([], { background: '#222', postEffects: [{ type: 'grain' } as any], grid: { mode: 'off' } as any })
    const next = S([], { background: '#000', postEffects: [], grid: { mode: 'columns' } as any })
    const out = mergeCompositorState(current, base, next)
    expect(out.background).toBe('#222')
    expect(out.postEffects).toEqual([{ type: 'grain' }])
    expect(out.grid).toEqual({ mode: 'columns' })
  })
  it('never mutates its inputs', () => {
    const base = S([L('a')]), current = S([L('a'), L('u')]), next = S([L('a', 0.1)])
    const snap = JSON.stringify([base, current, next])
    mergeCompositorState(current, base, next)
    expect(JSON.stringify([base, current, next])).toBe(snap)
  })
})
