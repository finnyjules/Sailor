import { describe, it, expect } from 'vitest'
import {
  SHAPES, SHAPE_NONE, SHAPE_FAMILIES, shapeById, isShapeId, familyOf, familyRuleFor, searchShapes, shapeOptions,
} from '../../app/lib/shapes/catalog'

describe('shape catalog', () => {
  it('exposes the manifest and looks up by id', () => {
    expect(SHAPES.length).toBe(100)
    expect(shapeById('sparkle')?.name).toBe('Sparkle')
    expect(shapeById('nope')).toBeUndefined()
    expect(isShapeId('sparkle')).toBe(true)
    expect(isShapeId(SHAPE_NONE)).toBe(false)
    expect(isShapeId(42)).toBe(false)
  })
  it('every id resolves to a family by rule (no fallback)', () => {
    for (const s of SHAPES) expect(familyRuleFor(s.id), s.id).not.toBeNull()
  })
  it('places known ids', () => {
    expect(familyOf('sun-rays')).toBe('suns')
    expect(familyOf('sparkle-invert')).toBe('suns')
    expect(familyOf('leaf-grow')).toBe('botanical')
    expect(familyOf('square-strokes-diagonal')).toBe('patterns')
    expect(familyOf('corner-radius-pattern-swap')).toBe('patterns')
    expect(familyOf('corner-radius')).toBe('geometric')
    expect(familyOf('diagram-venn')).toBe('diagram')
    expect(familyOf('plus')).toBe('symbols')
    expect(familyOf('unknown-thing')).toBe('symbols')
  })
  it('every family has at least one shape and the rail lists six', () => {
    expect(SHAPE_FAMILIES.map(f => f.id)).toEqual(['geometric', 'suns', 'botanical', 'patterns', 'symbols', 'diagram'])
    for (const fam of SHAPE_FAMILIES) expect(SHAPES.some(s => familyOf(s.id) === fam.id), fam.id).toBe(true)
  })
  it('searches id and name, case-insensitive; empty query returns all', () => {
    expect(searchShapes('').length).toBe(100)
    const suns = searchShapes('SUN')
    expect(suns.length).toBeGreaterThanOrEqual(4)
    expect(suns.every(s => s.id.includes('sun') || s.name.toLowerCase().includes('sun'))).toBe(true)
    expect(searchShapes('Sun rays').map(s => s.id)).toContain('sun-rays')
  })
  it('shapeOptions leads with none unless disallowed', () => {
    expect(shapeOptions(true)[0]).toBe(SHAPE_NONE)
    expect(shapeOptions(true).length).toBe(101)
    expect(shapeOptions(false)).not.toContain(SHAPE_NONE)
  })
})
