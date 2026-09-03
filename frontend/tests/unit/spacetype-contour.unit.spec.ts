import { describe, it, expect } from 'vitest'
import { frameEdgeSpecs } from '../../app/lib/spacetype/contourFrame'
import { contourEffect } from '../../app/lib/spacetype/effects/contour'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'

const HALF_PI = Math.PI / 2

describe('frameEdgeSpecs', () => {
  const edges = frameEdgeSpecs(10, 6)

  it('returns four edges: two horizontal, two vertical', () => {
    expect(edges.length).toBe(4)
    expect(edges.filter(e => e.orient === 'h').length).toBe(2)
    expect(edges.filter(e => e.orient === 'v').length).toBe(2)
  })
  it('horizontal edges span 2·halfW, vertical edges span 2·halfH (no thickness)', () => {
    for (const e of edges) expect(e.length).toBeCloseTo(e.orient === 'h' ? 20 : 12)
  })
  it('mitered for corner coverage: thickness extends horizontals (+t) and insets verticals (−t)', () => {
    const m = frameEdgeSpecs(10, 6, 2)
    for (const e of m) expect(e.length).toBeCloseTo(e.orient === 'h' ? 22 : 10)
    // positions stay on the border (the band straddles it); only lengths change
    expect([m[0]!.posX, m[0]!.posY]).toEqual([0, 6])
    expect([m[1]!.posX, m[1]!.posY]).toEqual([10, 0])
  })
  it('places edges on the frame border', () => {
    const top = edges[0]!, right = edges[1]!, bottom = edges[2]!, left = edges[3]!
    expect([top.posX, top.posY]).toEqual([0, 6])
    expect([right.posX, right.posY]).toEqual([10, 0])
    expect([bottom.posX, bottom.posY]).toEqual([0, -6])
    expect([left.posX, left.posY]).toEqual([-10, 0])
  })
  it('orients each edge clockwise (top 0, right −90°, bottom 180°, left +90°)', () => {
    expect(edges[0]!.rotZ).toBeCloseTo(0)
    expect(edges[1]!.rotZ).toBeCloseTo(-HALF_PI)
    expect(edges[2]!.rotZ).toBeCloseTo(Math.PI)
    expect(edges[3]!.rotZ).toBeCloseTo(HALF_PI)
  })
})

describe('contourEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(contourEffect.id).toBe('contour')
    expect(contourEffect.label.length).toBeGreaterThan(0)
    expect(contourEffect.controls.length).toBeGreaterThan(0)
  })
  it('every control has a default and a unique key', () => {
    const keys = contourEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of contourEffect.controls) expect(c.default).toBeDefined()
  })
  it('exposes the signature controls including the text-flow motion', () => {
    const keys = contourEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'typeSize', 'layers', 'innerWidth', 'innerHeight', 'rotate', 'view', 'colors', 'speed', 'flowSpeed', 'flowDir']) {
      expect(keys).toContain(k)
    }
  })
  it('is registered and resolvable by id (alongside its sibling tunnel)', () => {
    const ids = SPACE_TYPE_EFFECTS.map(e => e.id)
    expect(ids).toContain('contour')
    expect(ids).toContain('tunnel')
    expect(getEffect('contour').id).toBe(contourEffect.id)
  })
})
