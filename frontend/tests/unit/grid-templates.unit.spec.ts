import { describe, it, expect } from 'vitest'
import { GRID_TEMPLATES, GRID_TEMPLATE_IDS, gridTemplate } from '~/lib/frame/gridTemplates'
import { DEAL_VOCABS } from '~/lib/compositor/dealVocab'

describe('grid templates registry', () => {
  it('has the five playgrnd grid-family templates with unique ids', () => {
    const ids = GRID_TEMPLATES.map(t => t.id)
    expect(ids).toEqual(['modular', 'oddgrid', 'parcel', 'mosh', 'static'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(GRID_TEMPLATE_IDS).toEqual(ids)
  })

  it('gridTemplate looks up by id and returns undefined for an unknown one', () => {
    expect(gridTemplate('oddgrid')?.name).toBe('Oddgrid')
    expect(gridTemplate('nope')).toBeUndefined()
  })

  it('every template carries a valid deal config (vocab + ranges in bounds)', () => {
    for (const t of GRID_TEMPLATES) {
      expect(DEAL_VOCABS).toContain(t.deal.vocab)
      expect(t.deal.density).toBeGreaterThanOrEqual(0)
      expect(t.deal.density).toBeLessThanOrEqual(1)
      expect(t.deal.cellInset).toBeGreaterThanOrEqual(0)
      expect(t.deal.cellInset).toBeLessThanOrEqual(0.4)
      const g = t.deal.gen
      expect(g.colRange[0]).toBeGreaterThanOrEqual(1)
      expect(g.colRange[1]).toBeGreaterThanOrEqual(g.colRange[0])
      expect(g.rowRange[1]).toBeGreaterThanOrEqual(g.rowRange[0])
      expect(g.regularity).toBeGreaterThanOrEqual(0)
      expect(g.regularity).toBeLessThanOrEqual(1)
      expect(g.mergeMaxSpan).toBeGreaterThanOrEqual(1)
      expect(['none', 'mirror']).toContain(g.symmetry)
    }
  })

  it('every template carries a valid dealt-grid config (cells + density + variance in bounds)', () => {
    for (const t of GRID_TEMPLATES) {
      expect(DEAL_VOCABS).toContain(t.pattern.vocab)
      expect(t.pattern.dgCells).toBeGreaterThanOrEqual(2)
      expect(t.pattern.dgCells).toBeLessThanOrEqual(24)
      expect(t.pattern.dgDensity).toBeGreaterThanOrEqual(0.15)
      expect(t.pattern.dgDensity).toBeLessThanOrEqual(1)
      expect(t.pattern.dgSizeVar).toBeGreaterThanOrEqual(0)
      expect(t.pattern.dgSizeVar).toBeLessThanOrEqual(1)
    }
  })

  it('character holds: Modular is the most regular, Static the least; Static has the most cells', () => {
    const reg = (id: string) => gridTemplate(id)!.deal.gen.regularity
    expect(reg('modular')).toBeGreaterThan(reg('oddgrid'))
    expect(reg('oddgrid')).toBeGreaterThan(reg('static'))
    const cells = (id: string) => gridTemplate(id)!.pattern.dgCells
    expect(cells('static')).toBeGreaterThan(cells('modular'))
  })
})
