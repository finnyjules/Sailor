import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'

const baseState = (): CompositorState => ({
  layers: [{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any],
})

describe('setGrid', () => {
  it('defaults an absent grid to mode "off" before patching', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch: { columns: 4 } } })
    expect(r.ok).toBe(true)
    const grid = (r as any).template.grid
    expect(grid.mode).toBe('off')
    expect(grid.columns).toBe(4)
  })

  it('sets mode:generated with a patch and generate:true, writing a seed in 1..9999', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setGrid', args: { patch: { mode: 'generated', gen: { colRange: [4, 4] } }, generate: true },
    })
    expect(r.ok).toBe(true)
    const grid = (r as any).template.grid
    expect(grid.mode).toBe('generated')
    expect(grid.gen.colRange).toEqual([4, 4])
    expect(grid.gen.seed).toBeGreaterThanOrEqual(1)
    expect(grid.gen.seed).toBeLessThanOrEqual(9999)
  })

  it('switching to generated mode without a seed still rolls a fresh one', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch: { mode: 'generated' } } })
    expect(r.ok).toBe(true)
    const grid = (r as any).template.grid
    expect(grid.gen.seed).not.toBe(42) // defaultGrid()'s seed — vanishingly unlikely to re-roll to it
  })

  it('merges a partial patch over an existing grid without a reroll', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch: { mode: 'explicit', columns: 6, rows: 4 } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setGrid', args: { patch: { columns: 8 } } }) as any).template
    expect(s2.grid.mode).toBe('explicit')
    expect(s2.grid.columns).toBe(8)
    expect(s2.grid.rows).toBe(4)
  })

  it('merges a partial gen patch without clobbering other gen fields', () => {
    const s1 = (applyCompositorCommand(baseState(), {
      op: 'setGrid', args: { patch: { mode: 'generated', gen: { colRange: [3, 5], regularity: 0.5 } } },
    }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setGrid', args: { patch: { gen: { regularity: 0.9 } } } }) as any).template
    expect(s2.grid.gen.colRange).toEqual([3, 5])
    expect(s2.grid.gen.regularity).toBe(0.9)
  })

  it('reroll:true also rolls a fresh seed', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch: { mode: 'generated', gen: { seed: 1 } } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setGrid', args: { patch: {}, reroll: true } }) as any).template
    expect(s2.grid.gen.seed).toBeGreaterThanOrEqual(1)
    expect(s2.grid.gen.seed).toBeLessThanOrEqual(9999)
  })

  it('describeCompositor reports the active grid', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setGrid', args: { patch: { mode: 'explicit', columns: 6, rows: 4 } } }) as any).template
    const snap = describeCompositor(s1)
    expect(JSON.stringify(snap)).toContain('explicit 6×4')
  })
})
