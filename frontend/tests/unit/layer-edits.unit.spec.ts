import { describe, expect, it } from 'vitest'
import { nudgeLayers } from '../../app/lib/compositor/layerEdits'

const L = (id: string, x: number, y: number): any => ({ id, kind: 'rect', x, y, rotation: 0, opacity: 1, w: 0.1, h: 0.1 })

describe('nudgeLayers', () => {
  it('moves only selected layers by the delta', () => {
    const out = nudgeLayers([L('a', 0.2, 0.2), L('b', 0.5, 0.5)], new Set(['a']), 0.01, -0.02)
    expect(out[0].id).toBe('a')
    expect(out[0].x).toBeCloseTo(0.21)
    expect(out[0].y).toBeCloseTo(0.18)
    expect(out[1]).toMatchObject({ id: 'b', x: 0.5, y: 0.5 })
  })
  it('clamps to [-0.5, 1.5]', () => {
    const out = nudgeLayers([L('a', 1.49, -0.49)], new Set(['a']), 0.5, -0.5)
    expect(out[0].x).toBeCloseTo(1.5); expect(out[0].y).toBeCloseTo(-0.5)
  })
  it('returns the array unchanged for empty selection or zero delta', () => {
    const arr = [L('a', 0.2, 0.2)]
    expect(nudgeLayers(arr, new Set(), 0.01, 0.01)).toBe(arr)
    expect(nudgeLayers(arr, new Set(['a']), 0, 0)).toBe(arr)
  })
})

import { duplicateLayers } from '../../app/lib/compositor/layerEdits'

const G = (id: string, x: number, y: number, groupId?: string): any => ({ id, kind: 'rect', x, y, rotation: 0, opacity: 1, w: 0.1, h: 0.1, ...(groupId ? { groupId } : {}) })

describe('duplicateLayers', () => {
  const ids = () => { let n = 0; return () => `id${++n}` }
  const gids = () => { let n = 0; return () => `g${++n}` }

  it('clones a loose layer with a fresh id and offset, selection = the copy', () => {
    const r = duplicateLayers([G('a', 0.2, 0.2)], [], new Set(['a']), 0.02, ids(), gids())
    expect(r.layers).toHaveLength(2)
    expect(r.newIds).toEqual(['id1'])
    expect(r.layers[1]).toMatchObject({ id: 'id1', x: 0.22, y: 0.22 })
    expect(r.groups).toEqual([])
  })
  it('maps two layers sharing a group to ONE fresh group id', () => {
    const r = duplicateLayers([G('a', 0.2, 0.2, 'gsrc'), G('b', 0.3, 0.3, 'gsrc')], [{ id: 'gsrc' }], new Set(['a', 'b']), 0.02, ids(), gids())
    expect(r.layers).toHaveLength(4)
    const copies = r.layers.slice(2)
    expect(copies[0].groupId).toBe('g1')
    expect(copies[1].groupId).toBe('g1')
    expect(r.groups).toContainEqual({ id: 'g1' })
  })
  it('is a no-op for an empty selection', () => {
    const arr = [G('a', 0.2, 0.2)]
    const r = duplicateLayers(arr, [], new Set(), 0.02, ids(), gids())
    expect(r.layers).toBe(arr); expect(r.newIds).toEqual([])
  })
  it('deep-clones nested data (effects) so copies are independent', () => {
    const src: any = { ...G('a', 0.2, 0.2), effects: [{ type: 'drop_shadow', blur: 4 }] }
    const r = duplicateLayers([src], [], new Set(['a']), 0.02, ids(), gids())
    ;(r.layers[1] as any).effects[0].blur = 99
    expect((src as any).effects[0].blur).toBe(4)
  })
})

import { snapAngle } from '../../app/lib/compositor/layerEdits'

describe('snapAngle', () => {
  it('snaps to the nearest step', () => {
    expect(snapAngle(7, 15)).toBe(0)
    expect(snapAngle(8, 15)).toBe(15)
    expect(snapAngle(52, 15)).toBe(45)
    expect(snapAngle(-8, 15)).toBe(-15)
  })
  it('passes through when step is null or 0', () => {
    expect(snapAngle(37, null)).toBe(37)
    expect(snapAngle(37, 0)).toBe(37)
  })
})

import { computeSnapAdjust } from '../../app/lib/compositor/layerEdits'

describe('computeSnapAdjust', () => {
  const T = 0.02
  it('snaps the left edge to the canvas edge (0)', () => {
    const r = computeSnapAdjust({ cx: 0.105, cy: 0.5, hx: 0.1, hy: 0.1 }, [], T, T)
    expect(r.dx).toBeCloseTo(-0.005); expect(r.guideX).toBe(0)
  })
  it('snaps center to canvas center (0.5)', () => {
    const r = computeSnapAdjust({ cx: 0.49, cy: 0.5, hx: 0.1, hy: 0.1 }, [], T, T)
    expect(r.dx).toBeCloseTo(0.01); expect(r.guideX).toBe(0.5)
  })
  it("snaps to another layer's center", () => {
    const r = computeSnapAdjust({ cx: 0.31, cy: 0.5, hx: 0.05, hy: 0.05 }, [{ cx: 0.3, cy: 0.5, hx: 0.05, hy: 0.05 }], T, T)
    expect(r.dx).toBeCloseTo(-0.01); expect(r.guideX).toBe(0.25)
  })
  it('does nothing outside the threshold', () => {
    const r = computeSnapAdjust({ cx: 0.6, cy: 0.6, hx: 0.05, hy: 0.05 }, [], T, T)
    expect(r.dx).toBe(0); expect(r.dy).toBe(0); expect(r.guideX).toBeNull(); expect(r.guideY).toBeNull()
  })
  it('breaks ties in left/center/right edge order (matches original)', () => {
    // left edge (0.39) is 0.01 from other-layer edge 0.4; center (0.49) is 0.01 from canvas-center 0.5.
    // Left edge is processed first, so it wins the tie → guide 0.4.
    const r = computeSnapAdjust({ cx: 0.49, cy: 0.5, hx: 0.1, hy: 0.1 }, [{ cx: 0.4, cy: 0.5, hx: 0, hy: 0 }], T, T)
    expect(r.guideX).toBe(0.4)
    expect(r.dx).toBeCloseTo(0.01)
  })
})

import { mapKeyToEdit } from '../../app/lib/compositor/layerEdits'

describe('mapKeyToEdit', () => {
  it('maps arrows to nudge (small step)', () => {
    expect(mapKeyToEdit({ key: 'ArrowLeft' }, 1, 10)).toEqual({ type: 'nudge', dxPx: -1, dyPx: 0 })
    expect(mapKeyToEdit({ key: 'ArrowDown' }, 1, 10)).toEqual({ type: 'nudge', dxPx: 0, dyPx: 1 })
  })
  it('uses the large step with shift', () => {
    expect(mapKeyToEdit({ key: 'ArrowRight', shiftKey: true }, 1, 10)).toEqual({ type: 'nudge', dxPx: 10, dyPx: 0 })
  })
  it('maps cmd/ctrl+D to duplicate', () => {
    expect(mapKeyToEdit({ key: 'd', metaKey: true }, 1, 10)).toEqual({ type: 'duplicate' })
    expect(mapKeyToEdit({ key: 'D', ctrlKey: true }, 1, 10)).toEqual({ type: 'duplicate' })
  })
  it('returns null for unrelated keys and plain d', () => {
    expect(mapKeyToEdit({ key: 'd' }, 1, 10)).toBeNull()
    expect(mapKeyToEdit({ key: 'a', metaKey: true }, 1, 10)).toBeNull()
  })
})

describe('mapKeyToEdit copy/paste', () => {
  it('maps cmd/ctrl+C to copy', () => {
    expect(mapKeyToEdit({ key: 'c', metaKey: true }, 1, 10)).toEqual({ type: 'copy' })
    expect(mapKeyToEdit({ key: 'C', ctrlKey: true }, 1, 10)).toEqual({ type: 'copy' })
  })
  it('maps cmd/ctrl+V to offset paste, +Shift to in-place', () => {
    expect(mapKeyToEdit({ key: 'v', metaKey: true }, 1, 10)).toEqual({ type: 'paste', inPlace: false })
    expect(mapKeyToEdit({ key: 'v', metaKey: true, shiftKey: true }, 1, 10)).toEqual({ type: 'paste', inPlace: true })
  })
  it('plain c/v (no meta) is null', () => {
    expect(mapKeyToEdit({ key: 'c' }, 1, 10)).toBeNull()
    expect(mapKeyToEdit({ key: 'v' }, 1, 10)).toBeNull()
  })
})

import { dragHud } from '../../app/lib/compositor/layerEdits'

describe('dragHud', () => {
  const info = { wPx: 120.4, hPx: 60.6, xPx: 340.5, yPx: 200.2, rotation: 12.7 }
  it('scale → rounded W × H', () => { expect(dragHud('scale', info)).toEqual({ text: '120 × 61' }) })
  it('rotate → rounded degrees', () => { expect(dragHud('rotate', info)).toEqual({ text: '13°' }) })
  it('move → rounded X, Y', () => { expect(dragHud('move', info)).toEqual({ text: '341, 200' }) })
  it('null kind → null', () => { expect(dragHud(null, info)).toBeNull() })
})

// ── Wired layers are LIVE LINKS, not clonable data ───────────────────────────
// A wired layer's pixels come down one graph edge into ONE slot. Two layers on
// that slot would paint the same pixels twice, fight over the slot's `layer{N}_*`
// widgets (last write wins), and the server would still render a single copy —
// so the pure duplicator must never emit the second one. Converting the wired
// member into a SNAPSHOT needs the host's bake/upload, which is why that half
// lives at the editor boundary (`duplicateSelection` → `materializeWired`) and
// this layer only has to refuse cleanly.
const WD = (id: string, slot: number, x = 0.4, y = 0.4): any =>
  ({ id, kind: 'wired', slot, x, y, rotation: 0, opacity: 1, w: 0.5, lastAspect: 0.75 })

describe('duplicateLayers with wired members', () => {
  const ids2 = () => { let n = 0; return () => `id${++n}` }
  const gids2 = () => { let n = 0; return () => `g${++n}` }

  it('never emits a second live layer on the same slot', () => {
    const layers = [WD('w1', 0), G('a', 0.2, 0.2)]
    const r = duplicateLayers(layers, [], new Set(['w1', 'a']), 0.02, ids2(), gids2())
    expect(r.layers.filter((l: any) => l.kind === 'wired').map((l: any) => l.slot)).toEqual([0])
    expect(r.newIds).toHaveLength(1)
    expect(r.layers).toHaveLength(3)
    expect((r.layers[2] as any).kind).toBe('rect')
  })

  it('is a no-op when the selection is wired-only', () => {
    const layers = [WD('w1', 0)]
    const r = duplicateLayers(layers, [], new Set(['w1']), 0.02, ids2(), gids2())
    expect(r.newIds).toEqual([])
    expect(r.layers).toHaveLength(1)
  })

  it('still copies the grouped non-wired members of a mixed group', () => {
    const layers = [WD('w1', 0), G('a', 0.2, 0.2, 'g0'), G('b', 0.3, 0.3, 'g0')]
    const r = duplicateLayers(layers, [], new Set(['w1', 'a', 'b']), 0.02, ids2(), gids2())
    expect(r.newIds).toHaveLength(2)
    expect((r.layers[3] as any).groupId).toBe('g1')
    expect((r.layers[4] as any).groupId).toBe('g1')
  })
})

describe('duplicateLayers idMap', () => {
  it('maps every duplicated id to its copy', async () => {
    const { duplicateLayers } = await import('~/lib/compositor/layerEdits')
    const L = (id: string): any => ({ id, kind: 'rect', x: 0.2, y: 0.2, rotation: 0, opacity: 1, w: 0.1, h: 0.1 })
    let n = 0
    const r = duplicateLayers([L('a'), L('b'), L('c')], [], new Set(['a', 'c']), 0.02, () => `n${++n}`, () => 'g')
    expect([...r.idMap.entries()]).toEqual([['a', 'n1'], ['c', 'n2']])
    expect(r.newIds).toEqual(['n1', 'n2'])
  })
})
