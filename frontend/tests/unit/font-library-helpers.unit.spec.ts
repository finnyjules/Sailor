import { describe, it, expect } from 'vitest'
import { foundryFromRelPath, slug, familyId, faceId, isItalicFace, buildFamilies } from '../../scripts/fontLibrary.mjs'

describe('foundryFromRelPath', () => {
  it('maps the two bundles, rejects anything else', () => {
    expect(foundryFromRelPath('PPF Fonts - v7.72/Editorial New/PPEditorialNew-Bold.otf')).toEqual({ id: 'pangram', label: 'Pangram' })
    expect(foundryFromRelPath('Off Set v1.8/Fonts/OT Rhapsody/OTF/OTRhapsody-Thin.otf')).toEqual({ id: 'off-type', label: 'Off-Type' })
    expect(foundryFromRelPath('Mori/PPMori-Book.otf')).toBeNull()
  })
})

describe('slug / ids', () => {
  it('lowercases and dashes, collapsing runs', () => {
    expect(slug('PP Editorial New')).toBe('pp-editorial-new')
    expect(slug('OT 2049')).toBe('ot-2049')
    expect(familyId('pangram', 'PP Editorial New')).toBe('pangram-pp-editorial-new')
    expect(faceId('pangram', 'PPEditorialNew-HeavyItalic')).toBe('pangram-ppeditorialnew-heavyitalic')
  })
})

describe('isItalicFace', () => {
  it('detects italic from angle or style text', () => {
    expect(isItalicFace('Heavy Italic', 0)).toBe(true)
    expect(isItalicFace('Book', -12)).toBe(true)
    expect(isItalicFace('Regular', 0)).toBe(false)
  })
})

describe('buildFamilies', () => {
  const rec = (over) => ({ foundryId: 'pangram', foundryLabel: 'Pangram', family: 'PP Editorial New', style: 'Regular', weight: 400, italic: false, postscriptName: 'PPEditorialNew-Regular', src: 'PPF Fonts - v7.72/Editorial New/PPEditorialNew-Regular.otf', ...over })
  it('groups faces under one family, sorted by weight then italic, deduped by id', () => {
    const fams = buildFamilies([
      rec({ style: 'Heavy Italic', weight: 900, italic: true, postscriptName: 'PPEditorialNew-HeavyItalic', src: 'a/HeavyItalic.otf' }),
      rec({}),
      rec({}), // exact dup → deduped
    ])
    expect(fams).toHaveLength(1)
    expect(fams[0].id).toBe('pangram-pp-editorial-new')
    expect(fams[0].family).toBe('PP Editorial New')
    expect(fams[0].foundry).toBe('pangram')
    expect(fams[0].faces.map(f => f.id)).toEqual(['pangram-ppeditorialnew-regular', 'pangram-ppeditorialnew-heavyitalic'])
    expect(fams[0].faces[0]).toMatchObject({ weight: 400, style: 'Regular', italic: false })
  })
  it('separates families by (foundry, family) and sorts families by name', () => {
    const fams = buildFamilies([
      rec({ family: 'PP Mori', postscriptName: 'PPMori-Book', src: 'm/Book.otf' }),
      rec({}),
    ])
    expect(fams.map(f => f.family)).toEqual(['PP Editorial New', 'PP Mori'])
  })
})
