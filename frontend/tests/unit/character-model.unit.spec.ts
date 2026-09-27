import { describe, expect, it } from 'vitest'
import {
  coverFirstRefs, defaultState, emptyState, identityRefs, identityRefSet, lookFaceFilename,
  normalizeStateId, panelFilename, pickState,
  sortStatesLockedFirst, draftBadge, DRAFT_BADGE_TEXT, videoIdentityRefs,
} from '#shared/characters/types'

const state = (over: Partial<ReturnType<typeof emptyState>> = {}) => ({ ...emptyState('default', 'Default'), ...over })
const record = (over: Record<string, unknown> = {}) => ({ slug: 'reva', name: 'Reva', face: null, states: [], ...over }) as any

describe('normalizeStateId', () => {
  it('maps the default sentinel and empties to null', () => {
    expect(normalizeStateId('default')).toBe(null)
    expect(normalizeStateId('')).toBe(null)
    expect(normalizeStateId(undefined)).toBe(null)
    expect(normalizeStateId(null)).toBe(null)
  })
  it('passes real ids through', () => { expect(normalizeStateId('wet')).toBe('wet') })
})

describe('pickState', () => {
  const rec = { states: [state(), state({ id: 'wet', label: 'Wet' })] }
  it('null → default state', () => { expect(pickState(rec, null)?.id).toBe('default') })
  it('named → that state', () => { expect(pickState(rec, 'wet')?.id).toBe('wet') })
  it('unknown → default fallback', () => { expect(pickState(rec, 'gone')?.id).toBe('default') })
  it('no default → first', () => {
    expect(pickState({ states: [state({ id: 'only' })] }, null)?.id).toBe('only')
  })
})

describe('coverFirstRefs', () => {
  it('cover leads, order otherwise preserved', () => {
    expect(coverFirstRefs({ refImages: ['a', 'b', 'c'], coverIndex: 1 })).toEqual(['b', 'a', 'c'])
  })
  it('empty/undefined → []', () => { expect(coverFirstRefs(undefined)).toEqual([]) })
})

describe('identityRefs', () => {
  it('sheet leads when present', () => {
    const s = state({ sheetImage: 'sheet.png', refImages: ['a.png'], coverIndex: 0 })
    expect(identityRefs(s)).toEqual(['sheet.png', 'a.png'])
  })
  it('falls back to cover-first refs without a sheet', () => {
    const s = state({ refImages: ['a.png', 'b.png'], coverIndex: 1 })
    expect(identityRefs(s)).toEqual(['b.png', 'a.png'])
  })
})

describe('videoIdentityRefs', () => {
  it('sends the portrait and full-body front panels, never the sheet', () => {
    const s = state({
      sheetImage: 'sheet.png', refImages: ['a.png'], coverIndex: 0,
      panels: [
        { slot: 'face-smile', filename: 'smile.png' },
        { slot: 'body-front', filename: 'front.png' },
        { slot: 'portrait', filename: 'portrait.png' },
      ],
    })
    expect(videoIdentityRefs(record(), s)).toEqual(['portrait.png', 'front.png'])
  })
  it('sends whichever of the two panels exists, the face standing in for a missing portrait', () => {
    const s = state({ panels: [{ slot: 'body-front', filename: 'front.png' }], refImages: ['a.png'] })
    expect(videoIdentityRefs(record(), s)).toEqual(['front.png'])
    expect(videoIdentityRefs(record({ face: { filename: 'face.png', approvedAt: 'x' } }), s)).toEqual(['face.png', 'front.png'])
  })
  it('falls back to the cover alone — never two photos, which may be two people', () => {
    const s = state({ refImages: ['a.png', 'b.png', 'c.png'], coverIndex: 1 })
    expect(videoIdentityRefs(record(), s)).toEqual(['b.png'])
  })
  it('is empty for an empty look', () => {
    expect(videoIdentityRefs(record(), state({}))).toEqual([])
    expect(videoIdentityRefs(record(), undefined)).toEqual([])
  })
})

describe('identity ref sets', () => {
  const panel = (slot: string, filename: string) => ({ slot, filename, check: null, madeFrom: null })
  const briefState = (over: Record<string, unknown> = {}) => ({
    id: 'default', label: 'Default', descriptor: '', refImages: ['cover.png'], coverIndex: 0,
    panels: [], sheetImage: 'grid.png', clothes: [], face: null, status: 'draft', stressResult: null, updatedAt: '', ...over,
  }) as any
  const briefRecord = (over: Record<string, unknown> = {}) => ({ slug: 'reva', name: 'Reva', face: { filename: 'face.png', approvedAt: 'x' }, states: [], ...over }) as any

  it('uses the face-neutral panel as the front, then portrait, body front, body back', () => {
    const s = briefState({ panels: [panel('portrait', 'p.png'), panel('face-neutral', 'fn.png'), panel('body-front', 'bf.png'), panel('body-back', 'bb.png')] })
    expect(identityRefSet(briefRecord(), s)).toEqual({ name: 'Reva', front: 'fn.png', portrait: 'p.png', bodyFront: 'bf.png', bodyBack: 'bb.png' })
  })
  it('falls back to the look face, then the record face, then the cover for the front', () => {
    expect(identityRefSet(briefRecord(), briefState({ face: { filename: 'lookface.png', approvedAt: 'x' } })).front).toBe('lookface.png')
    expect(identityRefSet(briefRecord(), briefState()).front).toBe('face.png')
    expect(identityRefSet(briefRecord({ face: null }), briefState()).front).toBe('cover.png')
  })
  it('never returns the sheet grid', () => {
    const set = identityRefSet(briefRecord({ face: null }), briefState({ refImages: [] }))
    expect(Object.values(set)).not.toContain('grid.png')
  })
  it('videoIdentityRefs: portrait + body front; with no portrait panel, the face stands in', () => {
    expect(videoIdentityRefs(briefRecord(), briefState({ panels: [panel('portrait', 'p.png'), panel('body-front', 'bf.png')] }))).toEqual(['p.png', 'bf.png'])
    expect(videoIdentityRefs(briefRecord(), briefState({ panels: [panel('body-front', 'bf.png')] }))).toEqual(['face.png', 'bf.png'])
    expect(videoIdentityRefs(briefRecord({ face: null }), briefState())).toEqual(['cover.png'])
    expect(videoIdentityRefs(briefRecord({ face: null }), briefState({ refImages: [] }))).toEqual([])
  })
  it('lookFaceFilename prefers the look face', () => {
    expect(lookFaceFilename(briefRecord(), briefState({ face: { filename: 'l.png', approvedAt: '' } }))).toBe('l.png')
    expect(lookFaceFilename(briefRecord(), undefined)).toBe('face.png')
  })
})

describe('panelFilename', () => {
  it('finds a slot, null when missing', () => {
    const s = state({ panels: [{ slot: 'portrait', filename: 'p.png' }] })
    expect(panelFilename(s, 'portrait')).toBe('p.png')
    expect(panelFilename(s, 'body-back')).toBe(null)
  })
})

describe('sortStatesLockedFirst', () => {
  it('moves locked states to the front, preserving relative order otherwise', () => {
    const draft1 = state({ id: 'a', status: 'draft' })
    const testing = state({ id: 'b', status: 'testing' })
    const locked1 = state({ id: 'c', status: 'locked' })
    const draft2 = state({ id: 'd', status: 'draft' })
    const locked2 = state({ id: 'e', status: 'locked' })
    const sorted = sortStatesLockedFirst([draft1, testing, locked1, draft2, locked2])
    expect(sorted.map(s => s.id)).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('does not mutate the input array', () => {
    const list = [state({ id: 'a', status: 'draft' }), state({ id: 'b', status: 'locked' })]
    const original = [...list]
    sortStatesLockedFirst(list)
    expect(list).toEqual(original)
  })

  it('no locked states → order unchanged', () => {
    const list = [state({ id: 'a', status: 'draft' }), state({ id: 'b', status: 'testing' })]
    expect(sortStatesLockedFirst(list).map(s => s.id)).toEqual(['a', 'b'])
  })
})

describe('draftBadge', () => {
  it('null for a locked state — no badge needed', () => {
    expect(draftBadge('locked')).toBeNull()
  })
  it('flags draft with the exact visible text', () => {
    expect(draftBadge('draft')).toBe(DRAFT_BADGE_TEXT)
  })
  it('flags testing too — not yet locked means not yet stress-tested to lock', () => {
    expect(draftBadge('testing')).toBe(DRAFT_BADGE_TEXT)
  })
})
