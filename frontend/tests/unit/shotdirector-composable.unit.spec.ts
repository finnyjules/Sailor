import { describe, expect, it } from 'vitest'
import { useShotDirector } from '~/composables/useShotDirector'
import { createDefaultShotSheet, type ShotSheet } from '~/lib/shotdirector/types'
import { materializeCast } from '~/lib/shotdirector/cast'

describe('useShotDirector', () => {
  it('hydrates initial data into a reactive ShotSheet', () => {
    const initial = { intent: 'test intent' }
    let persistCalls = 0
    const persist = () => { persistCalls++ }

    const { sheet } = useShotDirector(initial, persist)

    // Should hydrate with defaults filled in
    expect(sheet.value.intent).toBe('test intent')
    expect(sheet.value.mode).toBe('reference')
    expect(sheet.value.subject).toBe('')
    expect(sheet.value.references).toEqual([])
  })

  it('addReference adds an image reference, emits @Image1 tag, and calls persist', () => {
    const initial = createDefaultShotSheet()
    let lastPersistedSheet: ShotSheet | undefined
    const persist = (s: ShotSheet) => { lastPersistedSheet = s }

    const { sheet, result, addReference } = useShotDirector(initial, persist)

    addReference('image', 'http://example.com/photo.jpg', 'identity-lock')

    // Check result has @Image1 tag
    expect(result.value.prompt).toContain('@Image1')
    // Check input has image_urls array
    expect(result.value.input.image_urls).toEqual(['http://example.com/photo.jpg'])
    // Check persist was called with updated sheet
    expect(lastPersistedSheet?.references).toHaveLength(1)
    expect(lastPersistedSheet?.references[0]).toMatchObject({
      kind: 'image',
      slot: 1,
      src: 'http://example.com/photo.jpg',
      role: 'identity-lock',
    })
  })

  it('addReference with multiple images assigns sequential slots', () => {
    const initial = createDefaultShotSheet()
    const persist = () => {}

    const { result, addReference } = useShotDirector(initial, persist)

    addReference('image', 'http://example.com/a.jpg', 'identity-lock')
    addReference('image', 'http://example.com/b.jpg', 'lighting-copy')

    expect(result.value.prompt).toContain('@Image1')
    expect(result.value.prompt).toContain('@Image2')
    expect(result.value.input.image_urls).toEqual([
      'http://example.com/a.jpg',
      'http://example.com/b.jpg',
    ])
  })

  it('removeReference removes a reference by kind+slot and calls persist', () => {
    const initial = createDefaultShotSheet()
    let lastPersistedSheet: ShotSheet | undefined
    const persist = (s: ShotSheet) => { lastPersistedSheet = s }

    const { result, addReference, removeReference } = useShotDirector(initial, persist)

    addReference('image', 'http://example.com/a.jpg', 'identity-lock')
    addReference('image', 'http://example.com/b.jpg', 'lighting-copy')

    removeReference('image', 1)

    expect(result.value.prompt).not.toContain('@Image1')
    expect(result.value.prompt).toContain('@Image2')
    expect(result.value.input.image_urls).toEqual(['http://example.com/b.jpg'])
    expect(lastPersistedSheet?.references).toHaveLength(1)
  })

  it('update calls the mutator, replaces sheet, and calls persist', () => {
    const initial = createDefaultShotSheet()
    let persistCalls = 0
    let lastPersistedSheet: ShotSheet | undefined
    const persist = (s: ShotSheet) => {
      persistCalls++
      lastPersistedSheet = s
    }

    const { sheet, update } = useShotDirector(initial, persist)

    update(s => ({ ...s, subject: 'A bird' }))

    expect(sheet.value.subject).toBe('A bird')
    expect(lastPersistedSheet?.subject).toBe('A bird')
    expect(persistCalls).toBe(1)
  })

  it('toggling mode from reference to firstLastFrame clears reference tags from prompt', () => {
    const initial = createDefaultShotSheet()
    const persist = () => {}

    const { result, addReference, update } = useShotDirector(initial, persist)

    // Start in reference mode, add an image
    addReference('image', 'http://example.com/a.jpg', 'identity-lock')
    expect(result.value.prompt).toContain('@Image1')

    // Switch to firstLastFrame mode
    update(s => ({ ...s, mode: 'firstLastFrame' }))

    // Reference tags should no longer appear in prompt
    expect(result.value.prompt).not.toContain('@Image')
  })

  it('profile follows the sheet\'s model (Seedance 2.0 by default)', () => {
    const { profile, update } = useShotDirector(createDefaultShotSheet(), () => {})
    expect(profile.value.id).toBe('seedance-2.0')
    update(s => ({ ...s, model: 'veo-3.1' }))
    expect(profile.value.id).toBe('veo-3.1')
  })

  it('setModel writes the model, switches Kling to first/last frame, clamps Veo\'s duration, and persists', () => {
    let persisted: ShotSheet | undefined
    const initial = createDefaultShotSheet()
    initial.format.durationS = 15
    const { sheet, setModel } = useShotDirector(initial, (s) => { persisted = s })
    setModel('kling-v3')
    expect(sheet.value.model).toBe('kling-v3')
    expect(sheet.value.mode).toBe('firstLastFrame')
    expect(sheet.value.format.durationS).toBe(15)
    setModel('veo-3.1')
    expect(sheet.value.format.durationS).toBe(8)
    expect(persisted?.model).toBe('veo-3.1')
  })

  it('compiles cast identity sets for Kling as elements', () => {
    const V = (n: string) => `/view?filename=${n}&type=input`
    const initial = createDefaultShotSheet()
    initial.model = 'kling-v3'
    initial.mode = 'firstLastFrame'
    initial.firstFrame = 'data:image/png;base64,f'
    initial.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
    const resolve = () => ({ vera: { name: 'Vera', front: V('f.png'), portrait: V('p.png'), bodyFront: null, bodyBack: null } })
    const { result } = useShotDirector(initial, () => {}, resolve)
    expect(result.value.input.elements).toEqual([{ frontal_image_url: V('f.png'), reference_image_urls: [V('p.png')] }])
  })

  it('result is a computed value that updates reactively', () => {
    const initial = createDefaultShotSheet()
    const persist = () => {}

    const { sheet, result, update } = useShotDirector(initial, persist)

    const initialPrompt = result.value.prompt

    update(s => ({
      ...s,
      subject: 'A golden retriever',
      action: 'running through a field',
    }))

    const newPrompt = result.value.prompt
    expect(newPrompt).not.toBe(initialPrompt)
    expect(newPrompt).toContain('A golden retriever')
    expect(newPrompt).toContain('running through a field')
  })

  it('does not double-persist when using update (persist called once)', () => {
    const initial = createDefaultShotSheet()
    let persistCalls = 0
    const persist = () => { persistCalls++ }

    const { update } = useShotDirector(initial, persist)

    update(s => ({ ...s, intent: 'new intent' }))

    // persist should be called once, not watched+called again
    expect(persistCalls).toBe(1)
  })

  it('rerollSeed sets a visible integer seed in [1, 2_147_483_646] and calls persist', () => {
    const initial = createDefaultShotSheet()
    let lastPersistedSheet: ShotSheet | undefined
    const persist = (s: ShotSheet) => { lastPersistedSheet = s }

    const { sheet, rerollSeed } = useShotDirector(initial, persist)

    rerollSeed()

    const seed = sheet.value.format.seed
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed as number).toBeGreaterThanOrEqual(1)
    expect(seed as number).toBeLessThanOrEqual(2_147_483_646)
    expect(lastPersistedSheet?.format.seed).toBe(seed)
  })

  it('rerollSeed changes the seed on successive calls', () => {
    const initial = createDefaultShotSheet()
    const persist = () => {}

    const { sheet, rerollSeed } = useShotDirector(initial, persist)

    const seeds = new Set<number>()
    for (let i = 0; i < 20; i++) {
      rerollSeed()
      seeds.add(sheet.value.format.seed as number)
    }

    // Overwhelmingly likely to produce more than one distinct value across 20 rerolls.
    expect(seeds.size).toBeGreaterThan(1)
  })
})

describe('useShotDirector cast', () => {
  const U = (n: string) => `/view?filename=${n}&type=input`

  it('addCastMember persists cast and result materializes refs + clause', () => {
    let persisted: ShotSheet | undefined
    const resolve = (picks: { slug: string; stateId: string | null }[]) =>
      Object.fromEntries(picks.map(({ slug: s }) => [s, [U(`${s}.png`)]]))
    const { sheet, result, addCastMember } = useShotDirector(createDefaultShotSheet(), (s) => { persisted = s }, resolve)

    addCastMember('reva', 'Reva')
    expect(sheet.value.cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }])
    expect(persisted?.cast).toHaveLength(1)
    // persisted sheet holds NO materialized cast refs
    expect(persisted?.references.some(r => r.castSlug)).toBe(false)
    // but the compiled result does
    expect(result.value.prompt).toContain('Characters: Reva @Image1.')
  })

  it('addCastMember dedupes; removeCastMember removes', () => {
    const { sheet, addCastMember, removeCastMember } = useShotDirector(createDefaultShotSheet(), () => {}, () => ({}))
    addCastMember('reva', 'Reva')
    addCastMember('reva', 'Reva', 'wire')
    expect(sheet.value.cast).toHaveLength(1)
    removeCastMember('reva')
    expect(sheet.value.cast).toHaveLength(0)
  })

  it('zero-ref cast member surfaces as an error issue in result', () => {
    const { result, addCastMember } = useShotDirector(createDefaultShotSheet(), () => {}, () => ({ reva: [] }))
    addCastMember('reva', 'Reva')
    expect(result.value.issues.some(i => i.code === 'cast-member-no-refs' && i.level === 'error')).toBe(true)
  })

  it('addCastMember stores a stateId and passes it to resolveCast', () => {
    let seenPicks: { slug: string; stateId: string | null }[] = []
    const resolve = (picks: { slug: string; stateId: string | null }[]) => {
      seenPicks = picks
      return Object.fromEntries(picks.map(({ slug: s }) => [s, [U(`${s}.png`)]]))
    }
    const { sheet, result, addCastMember } = useShotDirector(createDefaultShotSheet(), () => {}, resolve)

    addCastMember('reva', 'Reva', 'picker', 'raincoat')
    expect(sheet.value.cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: 'raincoat' }])
    void result.value // force the computed to evaluate resolveCast
    // picks also carry `name` for the castWarnings channel — assert structurally
    expect(seenPicks).toMatchObject([{ slug: 'reva', stateId: 'raincoat' }])
  })

  it('a null stateId (default state) round-trips as null — addCastMember does not re-normalize', () => {
    // The 'default' sentinel is understood exactly once, by normalizeStateId at
    // the caller boundary (CharacterPickerModal / the character bus); addCastMember
    // trusts whatever stateId it's handed.
    let seenPicks: { slug: string; stateId: string | null }[] = []
    const resolve = (picks: { slug: string; stateId: string | null }[]) => {
      seenPicks = picks
      return Object.fromEntries(picks.map(({ slug: s }) => [s, [U(`${s}.png`)]]))
    }
    const { sheet, result, addCastMember } = useShotDirector(createDefaultShotSheet(), () => {}, resolve)

    addCastMember('reva', 'Reva', 'picker', null)
    expect(sheet.value.cast).toEqual([{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }])
    void result.value // force the computed to evaluate resolveCast
    expect(seenPicks).toMatchObject([{ slug: 'reva', stateId: null }])
  })
})

describe('useShotDirector castWarnings channel', () => {
  it('merges warning issues from the castWarnings callback into result.issues', () => {
    const U = (n: string) => `/view?filename=${n}&type=input`
    const { result, addCastMember } = useShotDirector(
      createDefaultShotSheet(),
      () => {},
      () => ({ vera: [U('r1.png')] }),
      picks => picks.some(p => p.stateId === 'v-gone')
        ? [{ level: 'warning' as const, code: 'cast-variant-missing', message: 'Vera\'s selected look no longer exists — using their Default look.' }]
        : [],
    )
    addCastMember('vera', 'Vera', 'picker', 'v-gone')
    expect(result.value.issues.some(i => i.code === 'cast-variant-missing' && i.level === 'warning')).toBe(true)
    // warnings do not gate: no error-level issue from the warning itself
    expect(result.value.issues.filter(i => i.level === 'error')).toHaveLength(0)
  })
})
