// frontend/tests/unit/agent-grid.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'
import { suggestedLayoutGrid } from '~/lib/frame/layoutGrid'

const baseState = (): CompositorState => ({
  layers: [{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any],
  grid: suggestedLayoutGrid(1080, 1350, null),
})

describe('setGrid', () => {
  it('sets columns and square rows, making the grid the user\'s own', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { columns: 6, rows: 'square' } })
    expect(r.ok).toBe(true)
    const g = (r as any).template.grid
    expect(g.cols.count).toBe(6)
    expect(g.rows.mode).toBe('square')
    expect(g.auto).toBe(false)
  })
  it('shows or hides the grid without owning it', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { show: false } })
    expect((r as any).template.grid.show).toBe(false)
    expect((r as any).template.grid.auto).toBe(true)
  })
  it('suggested:true returns to the auto grid', () => {
    const s = baseState(); s.grid = { ...s.grid!, auto: false }
    const r = applyCompositorCommand(s, { op: 'setGrid', args: { suggested: true } })
    expect((r as any).template.grid.auto).toBe(true)
  })
  it('a generated-grid request points to mosaic', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { generate: true } })
    expect(r.ok).toBe(false)
    expect((r as any).detail).toMatch(/mosaic/)
  })
  it('the old { patch } shape is refused, naming the flat args', () => {
    for (const patch of [{ columns: 6 }, { mode: 'explicit' }, {}]) {
      const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch } }) as any
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('invalid')
      expect(r.detail).toMatch(/columns.*gutter.*margin.*fit.*rows.*line.*show/)
    }
  })
  it('describe reads the grid out in plain words', () => {
    const d = describeCompositor(baseState()) as any
    expect(JSON.stringify(d)).toMatch(/12 columns, square rows, line \d+ px/)
  })
  it('undoing a setGrid (its inverse) puts the grid back', () => {
    const s = baseState()
    const r = applyCompositorCommand(s, { op: 'setGrid', args: { columns: 6 } }) as any
    const back = applyCompositorCommand(r.template, r.inverse) as any
    expect(back.template.grid.cols.count).toBe(12)
  })
})

describe('mosaic create', () => {
  it('makes its own generated grid, never the Frame\'s', () => {
    const r = applyCompositorCommand(baseState(), { op: 'mosaic', args: {} })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers.at(-1)
    expect(layer.grid.mode).toBe('generated')
  })
})
