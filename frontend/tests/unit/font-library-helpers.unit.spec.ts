import { describe, it, expect } from 'vitest'
import { foundryFromRelPath, slug, familyId, faceId, isItalicFace, buildFamilies } from '../../scripts/fontLibrary.mjs'
import { buildFeaturedFamilies } from '../../scripts/fontLibrary.mjs'

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

describe('foundryFromRelPath — Featured bundle', () => {
  it('maps the Free Fonts bundle to bram-naus / Featured', () => {
    expect(foundryFromRelPath('Free Fonts/BDO Grotesk/BDOGrotesk-Regular.ttf'))
      .toEqual({ id: 'bram-naus', label: 'Featured' })
  })
})

describe('buildFeaturedFamilies', () => {
  const scanned = [{
    id: 'bram-naus-bdo-grotesk', family: 'BDO Grotesk', foundry: 'bram-naus',
    faces: [{ id: 'bram-naus-bdogrotesk-regular', weight: 400, style: 'Regular', italic: false, postscriptName: 'BDOGrotesk-Regular', src: 'Free Fonts/BDO Grotesk/BDOGrotesk-Regular.ttf' }],
  }]
  const seed = [
    { name: 'Sora', num: 26, source: 'google', googleFamily: 'Sora', license: 'OFL-1.1', redistributable: true },
    { name: 'BDO Grotesk', num: 112, source: 'self-hosted', license: 'OFL-1.1', redistributable: true },
    { name: 'Restricted Face', num: 200, source: 'self-hosted', license: 'Free-noredist', redistributable: false },
    { name: 'Missing Local', num: 300, source: 'self-hosted', license: 'OFL-1.1', redistributable: true },
  ]

  it('emits google families with no faces and a googleFamily', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const sora = fams.find(f => f.family === 'Sora')
    expect(sora).toMatchObject({ foundry: 'bram-naus', source: 'google', googleFamily: 'Sora', num: 26 })
    expect(sora.faces).toEqual([])
  })
  it('attaches license/num/source to a matched self-hosted family', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const bdo = fams.find(f => f.family === 'BDO Grotesk')
    expect(bdo).toMatchObject({ source: 'self-hosted', license: 'OFL-1.1', num: 112 })
    expect(bdo.faces.length).toBe(1)
  })
  it('drops a self-hosted seed entry with no scanned file', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    expect(fams.some(f => f.family === 'Missing Local')).toBe(false)
  })
  it('drops non-redistributable families when bundleRestricted is false', () => {
    // Use a google restricted entry so the only reason to drop it is the flag
    // (a file-less self-hosted entry would be dropped regardless).
    const seed2 = [{ name: 'Sneaky', num: 47, source: 'google', googleFamily: 'Sneaky Times', redistributable: false }]
    expect(buildFeaturedFamilies([], seed2, { bundleRestricted: true }).length).toBe(1)
    expect(buildFeaturedFamilies([], seed2, { bundleRestricted: false }).length).toBe(0)
  })
  it('sorts by num then family', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const nums = fams.map(f => f.num)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
  })
})
