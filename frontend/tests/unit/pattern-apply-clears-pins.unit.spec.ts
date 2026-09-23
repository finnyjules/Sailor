// frontend/tests/unit/pattern-apply-clears-pins.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { clearPinsOfMoved, clearGroupPinsOfMoved, applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

describe('clearPinsOfMoved', () => {
  it('drops explicit pins from layers whose placement changed, keeps them on the rest', () => {
    const moved = createRectLayer({ id: 'a', x: 0.2, pins: { h: 'right' } })
    const still = createRectLayer({ id: 'b', x: 0.7, pins: { v: 'bottom' } })
    const out = clearPinsOfMoved([moved, still], [{ ...moved, x: 0.4 }, still])
    expect(out[0]!.pins).toBeUndefined()
    expect(out[1]).toBe(still)
  })
  it('counts size, font size and rotation changes as moves; ignores colour', () => {
    const a = createRectLayer({ id: 'a', pins: { h: 'left' } })
    expect(clearPinsOfMoved([a], [{ ...a, w: a.w * 2 }])[0]!.pins).toBeUndefined()
    expect(clearPinsOfMoved([a], [{ ...a, rotation: 15 }])[0]!.pins).toBeUndefined()
    expect(clearPinsOfMoved([a], [{ ...a, fill: '#ff0000' }])[0]!.pins).toEqual({ h: 'left' })
  })
  it('a layer with no pins, or a new layer, passes through untouched', () => {
    const a = createRectLayer({ id: 'a' })
    const n = createRectLayer({ id: 'n', pins: { h: 'left' } })
    const out = clearPinsOfMoved([a], [{ ...a, x: 0.9 }, n])
    expect(out[0]!.pins).toBeUndefined()
    expect(out[1]).toBe(n)
  })
})

describe('clearGroupPinsOfMoved', () => {
  it('drops the pins of the outermost group whose member moved; leaves other groups alone', () => {
    const m = createRectLayer({ id: 'm', x: 0.2, groupId: 'inner' })
    const o = createRectLayer({ id: 'o', x: 0.8, groupId: 'other' })
    const groups = [
      { id: 'outer', pins: { h: 'right' as const } },
      { id: 'inner', parentId: 'outer' },
      { id: 'other', pins: { v: 'bottom' as const } },
    ]
    const out = clearGroupPinsOfMoved([m, o], [{ ...m, x: 0.5 }, o], groups)!
    expect(out.find(g => g.id === 'outer')!.pins).toBeUndefined()
    expect(out.find(g => g.id === 'outer')!.id).toBe('outer')
    expect(out.find(g => g.id === 'other')).toBe(groups[2])
  })
  it('drops the pins of EVERY group that encloses a moved member, not only the outermost', () => {
    const m = createRectLayer({ id: 'm', x: 0.2, groupId: 'inner' })
    const s = createRectLayer({ id: 's', x: 0.6, groupId: 'sibling' })
    const groups = [
      { id: 'outer', pins: { h: 'right' as const } },
      { id: 'middle', parentId: 'outer', pins: { v: 'top' as const } },
      { id: 'inner', parentId: 'middle', pins: { h: 'left' as const } },
      { id: 'sibling', parentId: 'outer', pins: { v: 'bottom' as const } },   // encloses nothing that moved
    ]
    const out = clearGroupPinsOfMoved([m, s], [{ ...m, x: 0.5 }, s], groups)!
    expect(out.find(g => g.id === 'outer')!.pins).toBeUndefined()
    expect(out.find(g => g.id === 'middle')!.pins).toBeUndefined()
    expect(out.find(g => g.id === 'middle')!.parentId).toBe('outer')
    expect(out.find(g => g.id === 'inner')!.pins).toBeUndefined()
    expect(out.find(g => g.id === 'sibling')).toBe(groups[3])
  })
  it('an inner group pin alone is cleared too (its outermost group has none)', () => {
    const m = createRectLayer({ id: 'm', x: 0.2, groupId: 'inner' })
    const groups = [{ id: 'outer' }, { id: 'inner', parentId: 'outer', pins: { h: 'left' as const } }]
    const out = clearGroupPinsOfMoved([m], [{ ...m, x: 0.5 }], groups)!
    expect(out).not.toBeNull()
    expect(out.find(g => g.id === 'inner')!.pins).toBeUndefined()
    expect(out.find(g => g.id === 'outer')).toBe(groups[0])
  })
  it('returns null when no pinned group had a member moved', () => {
    const m = createRectLayer({ id: 'm', groupId: 'g' })
    expect(clearGroupPinsOfMoved([m], [{ ...m, x: 0.9 }], [{ id: 'g' }])).toBeNull()
    expect(clearGroupPinsOfMoved([m], [m], [{ id: 'g', pins: { h: 'left' } }])).toBeNull()
  })
})

describe('applyPatternToFrame clears the pins it overrides', () => {
  it('commits the moved title without its pins and writes the group registry without its group pins', () => {
    const title = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, pins: { h: 'right' }, groupId: 'g' }
    const props = { sailor_localLayers: [title], sailor_localGroups: [{ id: 'g', pins: { v: 'top' } }] }
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const out = applyPatternToFrame({ props, frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette: { field: '#fff', ink: '#000', accent: '#f00' }, editor, connectedSlots: [] })
    expect(out.ok).toBe(true)
    const committed = editor.commit.mock.calls[0]![0] as any[]
    const t = committed.find(l => l.id === 't')
    expect(t.x !== 0.5 || t.y !== 0.5 || t.fontSize !== 0.2).toBe(true)
    expect(t.pins).toBeUndefined()
    expect(editor.writeGroups).toHaveBeenCalledTimes(1)
    expect(editor.writeGroups.mock.calls[0]![0][0].pins).toBeUndefined()
  })
})
