import { describe, it, expect } from 'vitest'
import { HDRI_ENVIRONMENTS, DEFAULT_HDRI, isKnownHdri, hdriLabel } from '~/lib/scene3d/hdri'
import { HDRI_OPTIONS, HDRI_BY_LABEL, HDRI_OPTION_NONE } from '~/lib/scene3d/panelPresentation'
import { defaultDoc, parseDoc } from '~/lib/scene3d/config'

describe('hdri registry', () => {
  it('every curated entry has a slug + sentence-case label + note', () => {
    expect(HDRI_ENVIRONMENTS.length).toBeGreaterThan(0)
    for (const h of HDRI_ENVIRONMENTS) {
      expect(h.slug).toMatch(/^[a-z0-9_]+$/) // a valid Poly Haven slug (matches the server route guard)
      expect(h.label[0]).toBe(h.label[0]?.toUpperCase()) // sentence case (UI copy rule)
      expect(h.note.length).toBeGreaterThan(0)
    }
  })

  it('the default HDRI is one of the curated entries', () => {
    expect(isKnownHdri(DEFAULT_HDRI)).toBe(true)
  })

  it('isKnownHdri gates unknown / empty / null slugs', () => {
    expect(isKnownHdri(HDRI_ENVIRONMENTS[0]!.slug)).toBe(true)
    expect(isKnownHdri('not_a_real_hdri')).toBe(false)
    expect(isKnownHdri('')).toBe(false)
    expect(isKnownHdri(null)).toBe(false)
    expect(isKnownHdri(undefined)).toBe(false)
  })

  it('hdriLabel maps a slug to its label, falling back to the slug', () => {
    const first = HDRI_ENVIRONMENTS[0]!
    expect(hdriLabel(first.slug)).toBe(first.label)
    expect(hdriLabel('unknown_slug')).toBe('unknown_slug') // browsable-future fallback
  })
})

describe('hdri picker labels (panel <-> doc)', () => {
  it('options are None plus every curated label, and the reverse map round-trips', () => {
    expect(HDRI_OPTIONS[0]).toBe(HDRI_OPTION_NONE)
    expect(HDRI_OPTIONS.length).toBe(HDRI_ENVIRONMENTS.length + 1)
    expect(HDRI_BY_LABEL[HDRI_OPTION_NONE]).toBeNull()
    for (const h of HDRI_ENVIRONMENTS) {
      expect(HDRI_OPTIONS).toContain(h.label)
      expect(HDRI_BY_LABEL[h.label]).toBe(h.slug)
    }
  })
})

describe('config: lighting.hdri', () => {
  it('defaults to null (procedural env)', () => {
    expect(defaultDoc().lighting.hdri).toBeNull()
  })

  it('round-trips a known HDRI slug and rejects an unknown one', () => {
    const withHdri = (hdri: unknown) =>
      JSON.stringify({ ...defaultDoc(), lighting: { ...defaultDoc().lighting, hdri } })

    expect(parseDoc(withHdri(DEFAULT_HDRI)).lighting.hdri).toBe(DEFAULT_HDRI)
    expect(parseDoc(withHdri('evil/../path')).lighting.hdri).toBeNull()
    expect(parseDoc(withHdri(null)).lighting.hdri).toBeNull()
  })
})
