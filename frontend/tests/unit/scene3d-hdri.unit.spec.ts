import { describe, it, expect } from 'vitest'
import { HDRI_ENVIRONMENTS, DEFAULT_HDRI, isKnownHdri, isValidHdriSlug, hdriLabel } from '~/lib/scene3d/hdri'
import { defaultDoc, parseDoc } from '~/lib/scene3d/config'
import { visibleSceneControls } from '~/lib/scene3d/controls'

const lightingKeys = (doc: ReturnType<typeof defaultDoc>) =>
  visibleSceneControls(doc).filter((c) => c.group === 'Lighting').map((c) => c.key)

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

describe('isValidHdriSlug (whole-library validation)', () => {
  it('accepts any well-formed Poly Haven slug, curated or not', () => {
    expect(isValidHdriSlug(DEFAULT_HDRI)).toBe(true)
    expect(isValidHdriSlug('kloofendal_48d_partly_cloudy_puresky')).toBe(true) // not curated, still valid
  })
  it('rejects path/uppercase/empty junk (matches the server route guard)', () => {
    for (const bad of ['evil/../path', 'Studio_Small', 'has space', '', null, undefined]) {
      expect(isValidHdriSlug(bad as never), String(bad)).toBe(false)
    }
  })
})

describe('lighting light-source modes (control gating)', () => {
  it('Studio-look mode shows the Look system, not the HDRI controls', () => {
    const keys = lightingKeys(defaultDoc()) // default: hdri null
    expect(keys).toContain('lighting.lightSource')
    expect(keys).toContain('lighting.look')
    expect(keys).toContain('lighting.environment')
    expect(keys).toContain('lighting.softness')
    expect(keys).not.toContain('lighting.hdri')
    expect(keys).not.toContain('lighting.hdriExposure')
    expect(keys).not.toContain('lighting.hdriRotation')
  })

  it('HDRI mode shows the HDRI controls, not the Look/procedural ones', () => {
    const doc = defaultDoc(); doc.lighting.hdri = DEFAULT_HDRI
    const keys = lightingKeys(doc)
    expect(keys).toContain('lighting.lightSource')
    expect(keys).toContain('lighting.hdri')
    expect(keys).toContain('lighting.hdriExposure')
    expect(keys).toContain('lighting.hdriRotation')
    for (const gone of ['lighting.look', 'lighting.softness', 'lighting.sunAzimuth', 'lighting.environment', 'lighting.preset']) {
      expect(keys, gone).not.toContain(gone)
    }
  })

  it('Custom detach hides the three dials (Studio-look mode)', () => {
    const doc = defaultDoc(); doc.lighting.custom = true
    const keys = lightingKeys(doc)
    for (const dial of ['lighting.softness', 'lighting.warmth', 'lighting.brightness']) {
      expect(keys, dial).not.toContain(dial)
    }
    expect(keys).toContain('lighting.look') // the Look row stays (to re-pick / reset)
  })

  it('the raw sun/ambient/preset are available in Studio-look mode (Fine-tune sub-card)', () => {
    // They're grouped into the collapsed Fine-tune sub-card by panelPresentation, but as controls
    // they're simply available throughout Studio-look mode (no Advanced toggle gates them now).
    const keys = lightingKeys(defaultDoc())
    for (const k of ['lighting.preset', 'lighting.sunIntensity', 'lighting.ambient']) {
      expect(keys, k).toContain(k)
    }
  })

  it('gel controls need Studio-look mode AND the Gels environment', () => {
    const gel = defaultDoc(); gel.lighting.environment = 'colorGels'
    expect(lightingKeys(gel)).toContain('lighting.gelColorA')
    const hdriOverGel = defaultDoc(); hdriOverGel.lighting.environment = 'colorGels'; hdriOverGel.lighting.hdri = DEFAULT_HDRI
    expect(lightingKeys(hdriOverGel)).not.toContain('lighting.gelColorA')
  })
})

describe('config: lighting.hdri', () => {
  it('defaults to null (procedural env)', () => {
    expect(defaultDoc().lighting.hdri).toBeNull()
  })

  it('round-trips any valid slug (whole library) and rejects malformed ones', () => {
    const withHdri = (hdri: unknown) =>
      JSON.stringify({ ...defaultDoc(), lighting: { ...defaultDoc().lighting, hdri } })

    expect(parseDoc(withHdri(DEFAULT_HDRI)).lighting.hdri).toBe(DEFAULT_HDRI)
    // A non-curated but valid Poly Haven slug must survive a save/reload now.
    expect(parseDoc(withHdri('kloofendal_48d_partly_cloudy_puresky')).lighting.hdri).toBe('kloofendal_48d_partly_cloudy_puresky')
    expect(parseDoc(withHdri('evil/../path')).lighting.hdri).toBeNull()
    expect(parseDoc(withHdri(null)).lighting.hdri).toBeNull()
  })
})
