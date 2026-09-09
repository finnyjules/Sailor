// frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

function frameProps(extra: Record<string, unknown> = {}) {
  return { sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 },
    { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 },
  ], ...extra }
}
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
const mk = () => ({ recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() })

describe('applyPatternToFrame', () => {
  it('records history once, commits once, writes order once — in that sequence', () => {
    const editor = mk(); const calls: string[] = []
    editor.recordHistory.mockImplementation(() => calls.push('history'))
    editor.commit.mockImplementation(() => calls.push('commit'))
    editor.writeOrder.mockImplementation(() => calls.push('order'))
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, editor })
    expect(out.ok).toBe(true)
    expect(calls).toEqual(['history', 'commit', 'order'])
    const committed = editor.commit.mock.calls[0][0]
    expect(committed[0].fontFamily).toBe('Inter')                 // face untouched
    expect(committed[0].x !== 0.5 || committed[0].y !== 0.5).toBe(true)
    expect(committed[0].fontSize).not.toBe(0.2)
  })
  it('photoBehind writes an order with the image behind the title, even if saved on top', () => {
    const editor = mk()
    applyPatternToFrame({ props: frameProps({ sailor_stackOrder: ['l:t', 'l:img'] }), frameW: 800, frameH: 1000, patternId: 'photoBehind', seed: 3, palette, editor })
    const order = editor.writeOrder.mock.calls[0][0] as string[]
    expect(order.indexOf('l:img')).toBeLessThan(order.indexOf('l:t'))
  })
  it('shapeCounter with no shape layer inserts one and orders it behind the title', () => {
    const editor = mk()
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'shapeCounter', seed: 5, palette, editor, shapeMode: { id: 'circle' } })
    expect(out.ok).toBe(true)
    const committed = editor.commit.mock.calls[0][0] as any[]
    const added = committed.find(l => l.kind === 'path')
    expect(added?.shapeId).toBe('circle')
    const order = editor.writeOrder.mock.calls[0][0] as string[]
    expect(order.indexOf(`l:${added.id}`)).toBeLessThan(order.indexOf('l:t'))
  })
  it('is a no-op for an unknown pattern id', () => {
    const editor = mk()
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'nope', seed: 1, palette, editor })
    expect(out.ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled(); expect(editor.commit).not.toHaveBeenCalled(); expect(editor.writeOrder).not.toHaveBeenCalled()
  })
})
