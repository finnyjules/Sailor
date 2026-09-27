import { describe, expect, it } from 'vitest'
import { CAST_MAX, castClause, materializeCast } from '~/lib/shotdirector/cast'
import { compileShot } from '~/lib/shotdirector/compile'
import { hydrateShotSheet } from '~/lib/shotdirector/hydrate'
import { KLING_V3_PROFILE, SEEDANCE_PROFILE, VEO_31_PROFILE } from '~/lib/shotdirector/profiles'
import { createDefaultShotSheet } from '~/lib/shotdirector/types'
import type { IdentityRefSet } from '#shared/characters/types'

const refSet = (over: Partial<IdentityRefSet> = {}): IdentityRefSet => ({
  name: 'x', front: null, portrait: null, bodyFront: null, bodyBack: null, ...over,
})

const U = (n: string) => `/view?filename=${n}&type=input`

function sheetWithCast() {
  const s = createDefaultShotSheet()
  s.cast = [
    { slug: 'reva', name: 'Reva', via: 'picker', stateId: null },
    { slug: 'marcus', name: 'Marcus', via: 'wire', stateId: null },
  ]
  return s
}

describe('materializeCast', () => {
  it('injects up to two refs per member (cast-first) and renumbers manual refs after', () => {
    const s = sheetWithCast()
    s.references = [{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }]
    const { sheet } = materializeCast(s, { reva: [U('rp'), U('rb'), U('extra')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const imgs = sheet.references.filter(r => r.kind === 'image')
    expect(imgs.map(r => [r.slot, r.src, r.castSlug ?? null])).toEqual([
      [1, U('rp'), 'reva'], [2, U('rb'), 'reva'], [3, U('m1'), 'marcus'], [4, U('manual.png'), null],
    ])
    expect(imgs[0]!.role).toBe('identity-lock')
  })

  it('sends at most two refs per member, however many resolve', () => {
    const s = sheetWithCast()
    s.cast = [s.cast[0]!]
    const { sheet } = materializeCast(s, { reva: [U('1'), U('2'), U('3'), U('4')] }, SEEDANCE_PROFILE)
    expect(sheet.references.filter(r => r.castSlug === 'reva').map(r => r.src)).toEqual([U('1'), U('2')])
  })

  it('is idempotent — re-materializing replaces cast refs, never duplicates', () => {
    const s = sheetWithCast()
    const once = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE).sheet
    const twice = materializeCast(once, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE).sheet
    expect(twice.references).toHaveLength(2)
  })

  it('gives each member their two refs when they fit the budget', () => {
    const s = sheetWithCast()
    s.references = Array.from({ length: 5 }, (_, i) => ({
      kind: 'image' as const, slot: i + 1, src: U(`man${i}`), role: 'style-transfer' as const,
    }))
    // 5 manual + 2×2 = 9 ≤ 9 → fits
    const { sheet, issues } = materializeCast(s, { reva: [U('1'), U('2'), U('3')], marcus: [U('4'), U('5'), U('6')] }, SEEDANCE_PROFILE)
    expect(sheet.references.filter(r => r.castSlug === 'reva')).toHaveLength(2)
    expect(sheet.references.filter(r => r.castSlug === 'marcus')).toHaveLength(2)
    expect(issues.find(i => i.code === 'cast-refs-squeezed')).toBeUndefined()
  })

  it('warns with "remove manual references" when budget < members (overcap)', () => {
    const s = sheetWithCast()
    s.cast = [
      { slug: 'a', name: 'Alice', via: 'picker' },
      { slug: 'b', name: 'Bob', via: 'picker' },
      { slug: 'c', name: 'Charlie', via: 'picker' },
    ]
    // 8 manual image refs + 3 members: budget 9 − 8 = 1; min 1 per member → would need 3 total,
    // but only 1 available, so budget < members (1 < 3)
    s.references = Array.from({ length: 8 }, (_, i) => ({
      kind: 'image' as const, slot: i + 1, src: U(`man${i}`), role: 'style-transfer' as const,
    }))
    const { sheet, issues } = materializeCast(s, { a: [U('1'), U('1b')], b: [U('2'), U('2b')], c: [U('3'), U('3b')] }, SEEDANCE_PROFILE)
    const warning = issues.find(i => i.level === 'warning' && i.code === 'cast-refs-squeezed')
    expect(warning).toBeDefined()
    expect(warning!.message).toContain('remove some manual references')
    // Verify downstream compile catches the overflow
    const compiled = compileShot(sheet, SEEDANCE_PROFILE)
    const err = compiled.issues.find(i => i.code === 'too-many-image-refs')
    expect(err).toBeDefined()
    expect(err!.message).toContain('9 image references')
  })

  it('errors on a member with zero resolved refs and on unknown slugs', () => {
    const s = sheetWithCast()
    const { issues } = materializeCast(s, { reva: [] }, SEEDANCE_PROFILE)
    const errs = issues.filter(i => i.level === 'error' && i.code === 'cast-member-no-refs')
    expect(errs).toHaveLength(2) // reva empty + marcus missing entirely
    expect(errs[0]!.message).toContain('Reva')
    expect(errs[0]!.message).toBe('Reva has no reference photos — add some to their character sheet.')
  })

  it('mentions the selected look in the zero-refs error when the member has a stateId', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: 'raincoat' }]
    const { issues } = materializeCast(s, { reva: [] }, SEEDANCE_PROFILE)
    const err = issues.find(i => i.level === 'error' && i.code === 'cast-member-no-refs')
    expect(err!.message).toBe('Reva has no reference photos in the selected look — add some to their character sheet.')
  })

  it('errors on duplicates and on more than CAST_MAX members', () => {
    const s = createDefaultShotSheet()
    s.cast = [
      { slug: 'a', name: 'A', via: 'picker', stateId: null }, { slug: 'a', name: 'A', via: 'wire', stateId: null },
      { slug: 'b', name: 'B', via: 'picker', stateId: null }, { slug: 'c', name: 'C', via: 'picker', stateId: null },
      { slug: 'd', name: 'D', via: 'picker', stateId: null },
    ]
    const { issues } = materializeCast(s, { a: [U('1')], b: [U('2')], c: [U('3')], d: [U('4')] }, SEEDANCE_PROFILE)
    expect(issues.some(i => i.code === 'cast-duplicate')).toBe(true)
    expect(issues.some(i => i.code === 'cast-too-many')).toBe(true)
    expect(CAST_MAX).toBe(3)
  })
})

describe('castClause', () => {
  it('names each member with their refs, marking a two-picture member as one person', () => {
    const s = sheetWithCast()
    const { sheet } = materializeCast(s, { reva: [U('r1'), U('r2')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE)).toBe('Characters: Reva @Image1 @Image2 (the same person); Marcus @Image3.')
  })
  it('is empty with no cast refs', () => {
    expect(castClause(createDefaultShotSheet(), SEEDANCE_PROFILE)).toBe('')
  })

  it('renders the descriptor in parens after the name when present', () => {
    const s = sheetWithCast()
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: 'soaked navy jacket, wet hair' }))
      .toBe('Characters: Reva (soaked navy jacket, wet hair) @Image1; Marcus @Image2.')
  })

  it('falls back to the plain form for an empty-string descriptor', () => {
    const s = sheetWithCast()
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: '' }))
      .toBe('Characters: Reva @Image1; Marcus @Image2.')
  })

  it('falls back to the plain form when descriptors is absent entirely', () => {
    const s = sheetWithCast()
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE))
      .toBe('Characters: Reva @Image1; Marcus @Image2.')
  })

  it('trims whitespace-padded descriptor text', () => {
    const s = sheetWithCast()
    s.cast = [s.cast[0]!]
    const { sheet } = materializeCast(s, { reva: [U('r1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: '  soaked navy jacket  ' }))
      .toBe('Characters: Reva (soaked navy jacket) @Image1.')
  })

  it('treats a whitespace-only descriptor as absent', () => {
    const s = sheetWithCast()
    s.cast = [s.cast[0]!]
    const { sheet } = materializeCast(s, { reva: [U('r1')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: '   ' }))
      .toBe('Characters: Reva @Image1.')
  })

  it('marks a member with two pictures as one person', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const { sheet } = materializeCast(s, { reva: [U('p'), U('b')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: 'soaked jacket' }))
      .toBe('Characters: Reva (soaked jacket) @Image1 @Image2 (the same person).')
  })
  it('leaves a one-picture member unchanged', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const { sheet } = materializeCast(s, { reva: [U('p')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE)).toBe('Characters: Reva @Image1.')
  })
})

describe('compileShot cast integration', () => {
  it('prepends the cast clause to the compiled prompt and counts it in the word budget', () => {
    const s = sheetWithCast()
    s.subject = 'two friends'
    s.action = 'walk along a pier'
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const res = compileShot(sheet, SEEDANCE_PROFILE)
    expect(res.prompt.startsWith('Characters: Reva @Image1; Marcus @Image2.')).toBe(true)
    expect(res.prompt).toContain('two friends')
  })
  it('prompt is unchanged for sheets with no cast', () => {
    const s = createDefaultShotSheet()
    s.subject = 'a lighthouse'
    s.action = 'stands in fog'
    expect(compileShot(s, SEEDANCE_PROFILE).prompt.startsWith('Characters:')).toBe(false)
  })

  it('splices the descriptor into the clause via opts.castDescriptors and counts it in the word budget', () => {
    const s = sheetWithCast()
    s.subject = 'two friends'
    s.action = 'walk along a pier'
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const withDescriptor = compileShot(sheet, SEEDANCE_PROFILE, { castDescriptors: { reva: 'soaked navy jacket, wet hair' } })
    const without = compileShot(sheet, SEEDANCE_PROFILE)
    expect(withDescriptor.prompt.startsWith('Characters: Reva (soaked navy jacket, wet hair) @Image1; Marcus @Image2.')).toBe(true)
    expect(withDescriptor.wordCount).toBeGreaterThan(without.wordCount)
  })

  it('with no opts passed, prompt is unchanged (back-compat guard: same as calling without the 3rd arg)', () => {
    const s = sheetWithCast()
    s.subject = 'two friends'
    s.action = 'walk along a pier'
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    expect(compileShot(sheet, SEEDANCE_PROFILE, undefined).prompt).toBe(compileShot(sheet, SEEDANCE_PROFILE).prompt)
    expect(compileShot(sheet, SEEDANCE_PROFILE).prompt).toContain('Characters: Reva @Image1; Marcus @Image2.')
  })
})

describe('hydrate back-compat', () => {
  it('old sheets without cast hydrate to []', () => {
    expect(hydrateShotSheet({ subject: 'x' }).cast).toEqual([])
  })
  it('cast entries survive hydration with stateId: null', () => {
    const cast = [{ slug: 'reva', name: 'Reva', via: 'picker' }]
    expect(hydrateShotSheet({ cast }).cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }])
  })
  it('a persisted stateId (current shape) survives hydration directly', () => {
    const cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: 'raincoat' }]
    expect(hydrateShotSheet({ cast }).cast).toEqual(cast)
  })
  it('migrates a legacy persisted variantId to stateId', () => {
    const cast = [{ slug: 'reva', name: 'Reva', via: 'picker', variantId: 'wet' }]
    expect(hydrateShotSheet({ cast }).cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: 'wet' }])
  })
  it('drops a non-string variantId, defaulting stateId to null', () => {
    const cast = [{ slug: 'reva', name: 'Reva', via: 'picker', variantId: 42 }]
    expect(hydrateShotSheet({ cast }).cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }])
  })
  it('normalizes legacy variantId "default" to stateId: null during hydration', () => {
    const cast = [{ slug: 'reva', name: 'Reva', via: 'picker', variantId: 'default' }]
    expect(hydrateShotSheet({ cast }).cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }])
  })
})

describe('compiled prompt noise suppression', () => {
  it('cast refs emit NO per-ref purpose sentence — the Characters clause covers them', () => {
    const s = sheetWithCast()
    const { sheet } = materializeCast(s, { reva: [U('r1'), U('r2')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const res = compileShot(sheet, SEEDANCE_PROFILE)
    expect(res.prompt).not.toContain('Use @Image')
    expect(res.prompt).not.toContain('identity and wardrobe')
  })

  it('manual refs still get their purpose sentence alongside cast refs', () => {
    const s = sheetWithCast()
    s.references = [{ kind: 'image', slot: 1, src: U('style.png'), role: 'style-transfer' }]
    const { sheet } = materializeCast(s, { reva: [U('r1')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const res = compileShot(sheet, SEEDANCE_PROFILE)
    // cast refs occupy @Image1@Image2; the manual ref renumbers to @Image3
    expect(res.prompt).toContain('Use @Image3 for the visual style.')
    expect(res.prompt).not.toContain('@Image1 for')
  })

  it('blank dialogue rows emit no stray empty quotes', () => {
    const s = createDefaultShotSheet()
    s.subject = 'a lighthouse'
    s.action = 'stands in fog'
    s.audio.dialogue = [{ speaker: '', line: '' }, { speaker: 'Vera', line: '' }]
    expect(compileShot(s, SEEDANCE_PROFILE).prompt).not.toContain('""')
  })
})

describe('materializeCast — elements mode (Kling)', () => {
  it('builds bundles in cast order and adds NO references to the sheet', () => {
    const s = sheetWithCast()
    s.references = [{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }]
    const resolved = {
      reva: refSet({ front: U('reva-front'), portrait: U('reva-portrait'), bodyFront: U('reva-body-front'), bodyBack: U('reva-body-back') }),
      marcus: refSet({ front: U('marcus-front'), portrait: U('marcus-portrait') }),
    }
    const { sheet, bundles, issues } = materializeCast(s, resolved, KLING_V3_PROFILE)
    expect(bundles).toEqual([
      { slug: 'reva', front: U('reva-front'), refs: [U('reva-portrait'), U('reva-body-front'), U('reva-body-back')] },
      { slug: 'marcus', front: U('marcus-front'), refs: [U('marcus-portrait')] },
    ])
    // Only the manual ref survives in sheet.references — no cast images added.
    expect(sheet.references).toEqual([{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }])
    expect(issues).toEqual([])
  })

  it('caps a bundle\'s refs at castRefCap - 1 and never duplicates the front picture', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const resolved = { reva: refSet({ front: U('f'), portrait: U('f'), bodyFront: U('bf'), bodyBack: U('bb') }) }
    const { bundles } = materializeCast(s, resolved, KLING_V3_PROFILE)
    // portrait === front is filtered out; castRefCap 4 -> at most 3 other refs, here 2 remain (bodyFront, bodyBack)
    expect(bundles).toEqual([{ slug: 'reva', front: U('f'), refs: [U('bf'), U('bb')] }])
  })

  it('raises cast-member-no-refs for a member with no front, and still bundles the rest', () => {
    const s = sheetWithCast()
    const resolved = {
      reva: refSet(),
      marcus: refSet({ front: U('marcus-front') }),
    }
    const { bundles, issues } = materializeCast(s, resolved, KLING_V3_PROFILE)
    expect(bundles).toEqual([{ slug: 'marcus', front: U('marcus-front'), refs: [] }])
    const err = issues.find(i => i.code === 'cast-member-no-refs')
    expect(err).toBeDefined()
    expect(err!.message).toContain('Reva')
  })

  it('an empty cast yields no bundles and preserves manual references', () => {
    const s = createDefaultShotSheet()
    s.references = [{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }]
    const { sheet, bundles, issues } = materializeCast(s, {}, KLING_V3_PROFILE)
    expect(bundles).toEqual([])
    expect(issues).toEqual([])
    expect(sheet.references).toEqual([{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }])
  })
})

describe('castClause — elements mode (Kling)', () => {
  it('tags members @Element1, @Element2… in bundle order', () => {
    const s = sheetWithCast()
    const { bundles } = materializeCast(s, {
      reva: refSet({ front: U('reva-front') }),
      marcus: refSet({ front: U('marcus-front') }),
    }, KLING_V3_PROFILE)
    expect(castClause(s, KLING_V3_PROFILE, undefined, bundles)).toBe('Characters: Reva @Element1; Marcus @Element2.')
  })

  it('splices the descriptor in, matching the images-mode clause style', () => {
    const s = sheetWithCast()
    const { bundles } = materializeCast(s, {
      reva: refSet({ front: U('reva-front') }),
      marcus: refSet({ front: U('marcus-front') }),
    }, KLING_V3_PROFILE)
    expect(castClause(s, KLING_V3_PROFILE, { reva: 'soaked navy jacket' }, bundles))
      .toBe('Characters: Reva (soaked navy jacket) @Element1; Marcus @Element2.')
  })

  it('is empty with no bundles', () => {
    expect(castClause(createDefaultShotSheet(), KLING_V3_PROFILE)).toBe('')
    expect(castClause(sheetWithCast(), KLING_V3_PROFILE, undefined, [])).toBe('')
  })
})

describe('materializeCast — images mode with IdentityRefSet (Veo, castRefCap 3)', () => {
  it('sends up to 3 pictures per member (front, portrait, bodyFront)', () => {
    const s = sheetWithCast()
    const resolved = {
      reva: refSet({ front: U('reva-front'), portrait: U('reva-portrait'), bodyFront: U('reva-body-front'), bodyBack: U('reva-body-back') }),
      marcus: refSet({ front: U('marcus-front') }),
    }
    const { sheet } = materializeCast(s, resolved, VEO_31_PROFILE)
    const imgs = sheet.references.filter(r => r.kind === 'image')
    expect(imgs.map(r => [r.slot, r.src, r.castSlug])).toEqual([
      [1, U('reva-front'), 'reva'], [2, U('reva-portrait'), 'reva'], [3, U('reva-body-front'), 'reva'],
      [4, U('marcus-front'), 'marcus'],
    ])
  })

  it('warns "remove some manual references" when 2 members at 3 refs each squeeze past maxRefImages (3)', () => {
    const s = sheetWithCast()
    const resolved = {
      reva: refSet({ front: U('rf'), portrait: U('rp'), bodyFront: U('rb') }),
      marcus: refSet({ front: U('mf'), portrait: U('mp'), bodyFront: U('mb') }),
    }
    const { issues } = materializeCast(s, resolved, VEO_31_PROFILE)
    const warning = issues.find(i => i.level === 'warning' && i.code === 'cast-refs-squeezed')
    expect(warning).toBeDefined()
    expect(warning!.message).toContain('remove some manual references')
    expect(warning!.message).toContain('3-image budget')
  })
})

describe('castMemberPictures', () => {
  const V = (n: string) => `/view?filename=${n}&type=input`
  const set = { name: 'Vera', front: V('f.png'), portrait: V('p.png'), bodyFront: V('bf.png'), bodyBack: V('bb.png') }

  it('Seedance: portrait + body front', async () => {
    const { castMemberPictures } = await import('~/lib/shotdirector/cast')
    const { SEEDANCE_PROFILE } = await import('~/lib/shotdirector/profiles')
    expect(castMemberPictures(set, SEEDANCE_PROFILE)).toEqual([V('p.png'), V('bf.png')])
  })

  it('Kling: the front first, then up to three more', async () => {
    const { castMemberPictures } = await import('~/lib/shotdirector/cast')
    const { KLING_V3_PROFILE } = await import('~/lib/shotdirector/profiles')
    expect(castMemberPictures(set, KLING_V3_PROFILE)).toEqual([V('f.png'), V('p.png'), V('bf.png'), V('bb.png')])
  })

  it('Kling with no front sends nothing', async () => {
    const { castMemberPictures } = await import('~/lib/shotdirector/cast')
    const { KLING_V3_PROFILE } = await import('~/lib/shotdirector/profiles')
    expect(castMemberPictures({ ...set, front: null }, KLING_V3_PROFILE)).toEqual([])
    expect(castMemberPictures(undefined, KLING_V3_PROFILE)).toEqual([])
  })
})
