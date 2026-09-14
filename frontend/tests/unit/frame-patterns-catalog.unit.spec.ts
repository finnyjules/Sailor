import { describe, it, expect } from 'vitest'
import { PATTERNS, fittingPatterns } from '~/lib/frame/patterns/catalog'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { ctxFor } from './_poster-fixtures'

describe('catalog', () => {
  it('registers all patterns with unique ids', () => {
    const ids = PATTERNS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'runoff', 'statement', 'index', 'shapeCounter', 'photoBehind',
      'tilt', 'bottomHeavy', 'fourCorners', 'spacedLines', 'ragged', 'edges', 'staircase', 'block',
      'knockout', 'shapeBleed', 'badge', 'split', 'fullBleed', 'diagonal', 'wall',
      'scatter', 'cascade', 'ring', 'cells',
    ]))
  })
  it('every pattern is deterministic and returns at least a title op', () => {
    for (const p of PATTERNS) {
      const ctx = ctxFor()
      if (p.needs?.shape && !ctx.elements.shapes.length) continue
      const out = p.place(ctx)
      expect(out).toEqual(p.place(ctxFor()))
      expect(out.ops.some(o => o.target === 'title')).toBe(true)
      expect(typeof out.did).toBe('string')
    }
  })
  it('drops shape/image patterns when the element is absent', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).not.toContain('shapeCounter')
    expect(ids).not.toContain('photoBehind')
    expect(ids).toContain('runoff')
  })
  it('keeps shape/image patterns when the element is present', () => {
    const ids = fittingPatterns(ctxFor()).map(p => p.id) // fixture has an image + a shape
    expect(ids).toContain('shapeCounter')
    expect(ids).toContain('photoBehind')
  })
  it('includes image patterns when imageMode is on (no real image)', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }], null, true)
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).toContain('split')
    expect(ids).toContain('fullBleed')
  })
  it('excludes image patterns when imageMode is off (no real image)', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }], null, false)
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).not.toContain('split')
    expect(ids).not.toContain('fullBleed')
  })
  it('offers exploded-letter moves for a single word', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).toContain('scatter')
    expect(ids).toContain('cascade')
  })
})
