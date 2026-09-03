import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor, summarizeCompositorChange } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'

const base = (): CompositorState => ({ layers: [] })

describe('addShape', () => {
  it('adds a centred library shape as a path layer', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'sparkle' } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.kind).toBe('path'); expect(l.shapeId).toBe('sparkle')
    expect(l.x).toBe(0.5); expect(l.y).toBe(0.5)
    expect(l.bbox.w).toBeCloseTo(0.3, 9)
    expect(l.id).toBe('l_1_shape')
  })
  it('honours x, y, w, fill and id, clamping the numbers', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'sun-rays', x: 0.85, y: -5, w: 9, fill: '#ff8800', id: 'sun' } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.id).toBe('sun'); expect(l.x).toBe(0.85); expect(l.y).toBe(-1); expect(l.bbox.w).toBeCloseTo(2, 9); expect(l.fill).toBe('#ff8800')
  })
  it('rejects unknown ids and duplicate layer ids', () => {
    expect(applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'unicorn' } })).toMatchObject({ ok: false, reason: 'invalid' })
    const s1 = (applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'heart', id: 'h' } }) as any).template
    expect(applyCompositorCommand(s1, { op: 'addShape', args: { shape: 'heart', id: 'h' } })).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('is undoable through the inverse snapshot', () => {
    const r = applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'plus' } }) as any
    const back = applyCompositorCommand(r.template, r.inverse) as any
    expect(back.ok).toBe(true); expect(back.template.layers.length).toBe(0)
  })
  it('is listed in the command menu with a hint', () => {
    const d = describeCompositor(base())
    const cmd = d.commands.find(c => c.op === 'addShape')
    expect(cmd?.hint).toMatch(/shape library/i)
  })
})

describe('describeCompositor with shapes', () => {
  it('names the shape on shape-backed paths and lists the library on the document', () => {
    const s = (applyCompositorCommand(base(), { op: 'addShape', args: { shape: 'leaf', id: 'leaf1' } }) as any).template as CompositorState
    const d = describeCompositor(s)
    const leaf = d.objects.find(o => o.id === 'leaf1')!
    expect(leaf.type).toBe('path'); expect(leaf.current.shape).toBe('leaf')
    const doc = d.objects.find(o => o.id === 'document')!
    expect(Array.isArray(doc.current.shapeLibrary)).toBe(true)
    expect((doc.current.shapeLibrary as string[]).length).toBe(100)
    expect(doc.current.shapeLibrary).toContain('sparkle')
  })
  it('summarises the change', () => {
    expect(summarizeCompositorChange(base(), { op: 'addShape', args: { shape: 'leaf' } })).toEqual({ label: 'Add shape', before: '', after: 'leaf' })
  })
})
