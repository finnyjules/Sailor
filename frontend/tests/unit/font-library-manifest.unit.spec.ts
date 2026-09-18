// frontend/tests/unit/font-library-manifest.unit.spec.ts
import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '../../shared/library-fonts'

const m = manifest as unknown as LibraryManifest

describe('generated library manifest', () => {
  it('has both foundries and a substantial family count', () => {
    expect(m.foundries.map(f => f.id).sort()).toEqual(['off-type', 'pangram'])
    expect(m.families.length).toBeGreaterThan(60)
  })
  it('every family + face id is unique', () => {
    const famIds = m.families.map(f => f.id)
    expect(new Set(famIds).size).toBe(famIds.length)
    const faceIds = m.families.flatMap(f => f.faces.map(x => x.id))
    expect(new Set(faceIds).size).toBe(faceIds.length)
  })
  it('every face has a weight in range, a style, an OTF src, a known foundry', () => {
    const foundries = new Set(m.foundries.map(f => f.id))
    for (const fam of m.families) {
      expect(foundries.has(fam.foundry)).toBe(true)
      expect(fam.faces.length).toBeGreaterThan(0)
      for (const face of fam.faces) {
        expect(face.weight).toBeGreaterThanOrEqual(1)
        expect(face.weight).toBeLessThanOrEqual(1000)
        expect(face.style.length).toBeGreaterThan(0)
        expect(face.src.toLowerCase().endsWith('.otf')).toBe(true)
      }
    }
  })
  it('includes known flagship families', () => {
    const names = new Set(m.families.map(f => f.family))
    expect([...names].some(n => /Editorial New/i.test(n))).toBe(true)
    expect([...names].some(n => /Mori/i.test(n))).toBe(true)
  })
})
