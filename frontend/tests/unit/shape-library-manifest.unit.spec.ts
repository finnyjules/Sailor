import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/shape-library.manifest.json'
import type { ShapeManifest } from '../../shared/shape-library'

const m = manifest as unknown as ShapeManifest

describe('generated shape-library manifest', () => {
  it('has 100 shapes with unique ids', () => {
    expect(m.shapes.length).toBe(100)
    expect(new Set(m.shapes.map(s => s.id)).size).toBe(100)
  })
  it('every shape has absolute M/L/C/Z path data inside the 96 box', () => {
    for (const s of m.shapes) {
      expect(s.d, s.id).toMatch(/^M/)
      expect(s.d.replace(/[0-9.,-]/g, ''), s.id).toMatch(/^[MLCZ]+$/)
      const [x, y, w, h] = s.box
      expect(w, s.id).toBeGreaterThan(0)
      expect(h, s.id).toBeGreaterThan(0)
      expect(x, s.id).toBeGreaterThanOrEqual(-1)
      expect(y, s.id).toBeGreaterThanOrEqual(-1)
      expect(x + w, s.id).toBeLessThanOrEqual(97)
      expect(y + h, s.id).toBeLessThanOrEqual(97)
      expect(s.sourceColor, s.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(['nonzero', 'evenodd']).toContain(s.fillRule)
    }
  })
  it('numbers are rounded to at most 2 decimals', () => {
    for (const s of m.shapes) expect(s.d, s.id).not.toMatch(/\.\d{3}/)
  })
  it('includes the shapes the separator demo and the rename rely on', () => {
    const ids = new Set(m.shapes.map(s => s.id))
    for (const id of ['sparkle', 'sun-rays', 'circle', 'triangle-double', 'triangle-hourglass', 'rhombus']) expect(ids.has(id), id).toBe(true)
  })
})
