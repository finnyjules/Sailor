import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'

const baseState = (): CompositorState => ({
  layers: [
    { id: 'shape', kind: 'ellipse', x: 0.5, y: 0.4, rotation: 0, opacity: 1, w: 0.4, h: 0.4, fill: '#fff', stroke: '', strokeWidth: 0 } as any,
    { id: 'subj', kind: 'image', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.6, h: 0.8, filename: 'p.png', maskedByKey: 'l:shape' } as any,
  ],
})

describe('setLayerMaskBreak', () => {
  it('sets a top break at the shape edge by default', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top' } })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers.find((l: any) => l.id === 'subj')
    expect(layer.maskBreak.angle).toBe(0)
    // Ellipse mask: y 0.4, h 0.4 -> top = 0.4 - 0.2 = 0.2
    expect(layer.maskBreak.y).toBeCloseTo(0.2, 5)
  })

  it('offset moves the break line toward the shape center', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top', offset: 0.5 } })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers.find((l: any) => l.id === 'subj')
    // top (0.2) + 0.5 * h (0.4) = 0.4 — the shape's own center
    expect(layer.maskBreak.y).toBeCloseTo(0.4, 5)
  })

  it('errors on an unknown edge', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'diagonal' } })
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('invalid')
  })

  it('errors when the target layer is not masked', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'shape', args: { edge: 'top' } })
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('invalid')
  })

  it('errors on an unknown layer id', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'nope', args: { edge: 'top' } })
    expect(r.ok).toBe(false)
  })

  it('remove:true clears the maskBreak', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top' } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setLayerMaskBreak', target: 'subj', args: { remove: true } }) as any).template
    expect(s2.layers.find((l: any) => l.id === 'subj').maskBreak).toBeUndefined()
  })

  it('describeCompositor reports the break edge', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top' } }) as any).template
    const snap = describeCompositor(s1)
    const obj = snap.objects.find(o => o.id === 'subj')
    expect(obj?.current.maskBreak).toBe('top')
  })

  it('summarizes the change', async () => {
    const { summarizeCompositorChange } = await import('~/lib/agent/surfaces/compositor')
    const s = baseState()
    const summary = summarizeCompositorChange(s, { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top' } })
    expect(summary?.after).toBe('top')
    const removeSummary = summarizeCompositorChange(s, { op: 'setLayerMaskBreak', target: 'subj', args: { remove: true } })
    expect(removeSummary?.after).toBe('removed')
  })

  it('undo via inverse restores no maskBreak', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerMaskBreak', target: 'subj', args: { edge: 'top' } }) as any
    expect(r.ok).toBe(true)
    const undone = applyCompositorCommand(r.template, r.inverse) as any
    expect(undone.ok).toBe(true)
    expect(undone.template.layers.find((l: any) => l.id === 'subj').maskBreak).toBeUndefined()
  })
})
