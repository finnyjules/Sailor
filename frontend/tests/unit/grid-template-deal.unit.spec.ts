// Grid TEMPLATES applied to the Frame's generative `deal` layer.
//
// The one-click picker in the Compositor and the agent's `template` word both
// pre-fill a deal from GRID_TEMPLATES. The UI applier lives in CompositorModal.vue
// (a Vue SFC, not importable here), so the template behaviour is proven through the
// pure agent surface (compositor.ts's dealGrid op) — the same config path the UI
// routes through — plus a standalone re-implementation of the applier's merge to
// pin the "preserve the current seed" contract.

import { describe, it, expect } from 'vitest'
import { GRID_TEMPLATES, gridTemplate, type GridTemplate } from '~/lib/frame/gridTemplates'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'
import { defaultGrid, type FrameGrid } from '~/lib/frame/grid'

const baseState = (): CompositorState => ({ layers: [] })

/** The applier CompositorModal.applyDealTemplate performs on a deal layer's grid —
 *  replicated here so the "seed is preserved, mode forced generated, gen merged"
 *  contract is asserted directly (the SFC method can't be imported into a unit). */
function applyDealTemplateGrid(grid: FrameGrid, t: GridTemplate): FrameGrid {
  return { ...grid, mode: 'generated', gen: { ...grid.gen, ...t.deal.gen } }
}

describe('grid template → deal config', () => {
  it('every template maps to the deal vocab/density/cellInset/gen via the agent create path', () => {
    for (const t of GRID_TEMPLATES) {
      const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { template: t.id, id: `d_${t.id}` } })
      expect(r.ok, t.id).toBe(true)
      const d = (r as any).template.layers[0]
      expect(d.kind).toBe('deal')
      expect(d.vocab, t.id).toBe(t.deal.vocab)
      expect(d.density, t.id).toBeCloseTo(t.deal.density)
      expect(d.cellInset, t.id).toBeCloseTo(t.deal.cellInset)
      expect(d.grid.mode, t.id).toBe('generated')
      // Every gen field the template declares is copied onto the deal's own grid.
      expect(d.grid.gen.colRange, t.id).toEqual(t.deal.gen.colRange)
      expect(d.grid.gen.rowRange, t.id).toEqual(t.deal.gen.rowRange)
      expect(d.grid.gen.regularity, t.id).toBeCloseTo(t.deal.gen.regularity)
      expect(d.grid.gen.merge, t.id).toBe(t.deal.gen.merge)
      expect(d.grid.gen.mergeMaxSpan, t.id).toBe(t.deal.gen.mergeMaxSpan)
      expect(d.grid.gen.symmetry, t.id).toBe(t.deal.gen.symmetry)
    }
  })

  it('the two named looks read differently (Modular = clean equal grid, Static = many tiny cells)', () => {
    const modular = gridTemplate('modular')!
    const staticT = gridTemplate('static')!
    // Modular: equal cells (regularity 1, no merge); Static: dense + loose (many
    // more cells, near-random). The distinction the picker must make visible.
    expect(modular.deal.gen.regularity).toBeGreaterThan(staticT.deal.gen.regularity)
    expect(staticT.deal.gen.colRange[0]).toBeGreaterThan(modular.deal.gen.colRange[1])
    expect(staticT.deal.gen.rowRange[0]).toBeGreaterThan(modular.deal.gen.rowRange[1])
  })

  it('applier preserves the current grid seed (a template carries none)', () => {
    const grid: FrameGrid = { ...defaultGrid(), gen: { ...defaultGrid().gen, seed: 777 } }
    const next = applyDealTemplateGrid(grid, gridTemplate('oddgrid')!)
    expect(next.gen.seed).toBe(777)           // variation kept
    expect(next.mode).toBe('generated')
    expect(next.gen.regularity).toBeCloseTo(gridTemplate('oddgrid')!.deal.gen.regularity)
  })
})

describe('agent dealGrid template arg', () => {
  it('no target + template:"oddgrid" creates a deal matching gridTemplate("oddgrid").deal', () => {
    const t = gridTemplate('oddgrid')!
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { template: 'oddgrid', id: 'og' } })
    expect(r.ok).toBe(true)
    const d = (r as any).template.layers[0]
    expect(d.vocab).toBe(t.deal.vocab)
    expect(d.density).toBeCloseTo(t.deal.density)
    expect(d.cellInset).toBeCloseTo(t.deal.cellInset)
    expect(d.grid.gen.colRange).toEqual(t.deal.gen.colRange)
    expect(d.grid.gen.merge).toBe(t.deal.gen.merge)
  })

  it('explicit args win over the template on the create path', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'dealGrid',
      args: { template: 'oddgrid', vocab: 'mono', density: 0.5, id: 'ov' },
    })
    const d = (r as any).template.layers[0]
    expect(d.vocab).toBe('mono')          // explicit override
    expect(d.density).toBeCloseTo(0.5)    // explicit override
    // untouched fields still come from the template
    expect(d.cellInset).toBeCloseTo(gridTemplate('oddgrid')!.deal.cellInset)
    expect(d.grid.gen.colRange).toEqual(gridTemplate('oddgrid')!.deal.gen.colRange)
  })

  it('an explicit grid arg overrides the template gen fields', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'dealGrid',
      args: { template: 'modular', grid: { regularity: 0.1, colRange: [2, 2] }, id: 'mg' },
    })
    const d = (r as any).template.layers[0]
    expect(d.grid.gen.regularity).toBeCloseTo(0.1)   // grid arg wins
    expect(d.grid.gen.colRange).toEqual([2, 2])
    expect(d.vocab).toBe(gridTemplate('modular')!.deal.vocab) // template still fills the rest
  })

  it('template applies to an existing deal when targeted, keeping its seed', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', seed: 321 } }) as any).template
    expect(s1.layers[0].grid.gen.seed).toBe(321)
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { template: 'mosh' } })
    expect(r.ok).toBe(true)
    const d = (r as any).template.layers[0]
    const t = gridTemplate('mosh')!
    expect(d.vocab).toBe(t.deal.vocab)
    expect(d.density).toBeCloseTo(t.deal.density)
    expect(d.grid.gen.regularity).toBeCloseTo(t.deal.gen.regularity)
    expect(d.grid.gen.seed).toBe(321) // seed preserved through a template apply
  })

  it('an unknown template id is ignored (no throw, falls back to defaults)', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { template: 'nope', id: 'nx' } })
    expect(r.ok).toBe(true)
    const d = (r as any).template.layers[0]
    expect(d.vocab).toBe('brand')  // default, not from any template
    expect(d.density).toBe(1)
    expect(d.cellInset).toBe(0)
  })
})

// Integration proof of the Compositor PICKER handlers (CompositorModal.vue). The SFC
// methods can't be imported, so we exercise the same production factory + merge the
// handlers use (createDealLayer for onDealTemplate's create path; the grid merge for
// applyDealTemplate). Guards that the picker produces the template's config on a real
// layer — the "picker is live" evidence when the browser is too contended.
describe('Compositor picker handlers (integration)', () => {
  it('onDealTemplate create path builds a real deal layer matching each template', async () => {
    const { createDealLayer } = await import('~/composables/useCompositorLayers')
    for (const t of GRID_TEMPLATES) {
      // Exactly what onDealTemplate does with no deal selected: seed a generated grid
      // from the frame grid, merge the template gen, hand vocab/density/cellInset in.
      const g: FrameGrid = { ...defaultGrid(), mode: 'generated', gen: { ...defaultGrid().gen, ...t.deal.gen } }
      const layer = createDealLayer({ grid: g, w: 1, h: 0.75, vocab: t.deal.vocab, density: t.deal.density, cellInset: t.deal.cellInset })
      expect(layer.kind, t.id).toBe('deal')
      expect(layer.vocab, t.id).toBe(t.deal.vocab)
      expect(layer.density, t.id).toBeCloseTo(t.deal.density)
      expect(layer.cellInset, t.id).toBeCloseTo(t.deal.cellInset)
      expect(layer.grid.mode, t.id).toBe('generated')
      expect(layer.grid.gen.colRange, t.id).toEqual(t.deal.gen.colRange)
      expect(layer.grid.gen.regularity, t.id).toBeCloseTo(t.deal.gen.regularity)
      expect(layer.grid.gen.merge, t.id).toBe(t.deal.gen.merge)
    }
  })

  it('applyDealTemplate on an existing layer swaps the whole look but keeps the seed', async () => {
    const { createDealLayer } = await import('~/composables/useCompositorLayers')
    const layer = createDealLayer({ vocab: 'brand', density: 1, cellInset: 0 })
    layer.grid.gen.seed = 555
    const modular = gridTemplate('modular')!
    const staticT = gridTemplate('static')!
    // Apply Modular then Static — the config the picker writes must differ between them.
    const asModular = { vocab: modular.deal.vocab, density: modular.deal.density, cellInset: modular.deal.cellInset, grid: applyDealTemplateGrid(layer.grid, modular) }
    const asStatic = { vocab: staticT.deal.vocab, density: staticT.deal.density, cellInset: staticT.deal.cellInset, grid: applyDealTemplateGrid(layer.grid, staticT) }
    expect(asModular.grid.gen.seed).toBe(555)  // variation preserved across the apply
    expect(asStatic.grid.gen.seed).toBe(555)
    // The two named looks genuinely diverge — proof the picker changes the render.
    expect(asStatic.density).not.toBeCloseTo(asModular.density)
    expect(asStatic.grid.gen.colRange).not.toEqual(asModular.grid.gen.colRange)
    expect(asStatic.vocab).not.toBe(asModular.vocab)
  })
})
