import { describe, it, expect } from 'vitest'
import { readGrid, gridProperty } from '~/lib/frame/gridConfig'
import { defaultGrid } from '~/lib/frame/grid'

describe('readGrid', () => {
  it('absent → default (off)', () => {
    expect(readGrid(undefined).mode).toBe('off')
    expect(readGrid({}).mode).toBe('off')
  })

  it('fills missing keys from the default', () => {
    const g = readGrid({ sailor_localGrid: { mode: 'explicit', columns: 8 } })
    expect(g.mode).toBe('explicit')
    expect(g.columns).toBe(8)
    expect(g.gen.regularity).toBe(defaultGrid().gen.regularity)  // filled
    expect(g.baseModule).toBe(defaultGrid().baseModule)
  })

  it('deep merges nested objects', () => {
    const g = readGrid({ sailor_localGrid: { mode: 'generated', gen: { seed: 123 } } })
    expect(g.mode).toBe('generated')
    expect(g.gen.seed).toBe(123)
    expect(g.gen.colRange).toStrictEqual(defaultGrid().gen.colRange)  // filled from default
    expect(g.gen.regularity).toBe(defaultGrid().gen.regularity)  // filled from default
  })

  it('returns the full default when sailor_localGrid is absent', () => {
    const g = readGrid(undefined)
    const def = defaultGrid()
    expect(g).toEqual(def)
  })
})

describe('gridProperty', () => {
  it('wraps grid for writes', () => {
    const grid = defaultGrid()
    const prop = gridProperty(grid)
    expect(prop).toHaveProperty('sailor_localGrid')
    expect(prop.sailor_localGrid).toEqual(grid)
  })

  it('wraps modified grid', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 12 }
    const prop = gridProperty(grid)
    expect(prop.sailor_localGrid.mode).toBe('explicit')
    expect(prop.sailor_localGrid.columns).toBe(12)
  })
})
