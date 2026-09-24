import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  resolveFontFamily,
  fontHasWeightAxis,
  setFontCatalog,
  LEGACY_FONT_IDS,
  type GoogleFontLike,
} from '~/lib/font/resolveFamily'

// This module is imported by 12 Space Type effect modules that end up in the
// spacetype.js embed bundle, which must never reach the network (see
// externalRefs() in app/lib/embed/bundle.ts and
// tests/unit/embed-build-output.unit.spec.ts). The regression this guards
// against: the old ~/data/google-fonts.ts pulled in ~/data/variable-fonts.ts
// for a single id→family lookup, dragging ~10 fonts.googleapis.com URLs (plus
// SIL/OFL licence links) into every Space Type export. This module must never
// grow another one.
const SELF = fileURLToPath(new URL('../../app/lib/font/resolveFamily.ts', import.meta.url))

describe('resolveFamily (network-free font resolver)', () => {
  afterEach(() => {
    setFontCatalog(null)
  })

  it('contains no URL literals — the regression guard for the whole module', () => {
    const src = fs.readFileSync(SELF, 'utf8')
    expect(src).not.toMatch(/http/i)
  })

  describe('resolveFontFamily', () => {
    it('returns Inter for an empty value', () => {
      expect(resolveFontFamily('')).toBe('Inter')
    })

    it('returns a value matching a catalog family unchanged', () => {
      const catalog: GoogleFontLike[] = [
        { family: 'Archivo', weights: [400, 700], axes: [{ tag: 'wght' }] },
      ]
      setFontCatalog(catalog)
      expect(resolveFontFamily('Archivo')).toBe('Archivo')
    })

    it('resolves a legacy VARIABLE_FONTS id to its family name', () => {
      expect(resolveFontFamily('inter')).toBe('Inter')
      expect(resolveFontFamily('roboto-flex')).toBe('Roboto Flex')
      expect(resolveFontFamily('source-serif')).toBe('Source Serif 4')
    })

    it('returns an unknown value unchanged, assuming it is already a family name', () => {
      expect(resolveFontFamily('Some Unknown Font')).toBe('Some Unknown Font')
    })

    it('reads a google:Family@weight token (Loft\'s Font default) as its family', () => {
      expect(resolveFontFamily('google:Archivo Black@700')).toBe('Archivo Black')
      expect(resolveFontFamily('google:Archivo Black')).toBe('Archivo Black')
      expect(resolveFontFamily('google: Work Sans @ 500')).toBe('Work Sans')
      // A token over a legacy id resolves through it; an empty one is the default family.
      expect(resolveFontFamily('google:inter@400')).toBe('Inter')
      expect(resolveFontFamily('google:@700')).toBe('Inter')
    })
  })

  describe('fontHasWeightAxis', () => {
    it('defaults to true with no catalog loaded', () => {
      expect(fontHasWeightAxis('Archivo')).toBe(true)
    })

    it('is true for a family with a wght axis', () => {
      setFontCatalog([{ family: 'Archivo', weights: [400], axes: [{ tag: 'wght' }] }])
      expect(fontHasWeightAxis('Archivo')).toBe(true)
    })

    it('is false for a family with one static weight and no wght axis', () => {
      setFontCatalog([{ family: 'Pacifico', weights: [400], axes: [] }])
      expect(fontHasWeightAxis('Pacifico')).toBe(false)
    })

    it('is true for a family with multiple static weights even without a wght axis', () => {
      setFontCatalog([{ family: 'Static Multi', weights: [400, 700], axes: [] }])
      expect(fontHasWeightAxis('Static Multi')).toBe(true)
    })
  })

  it('LEGACY_FONT_IDS has no URL literals and matches the known legacy ids', () => {
    expect(LEGACY_FONT_IDS['inter']).toBe('Inter')
    expect(LEGACY_FONT_IDS['big-shoulders']).toBe('Big Shoulders Display')
    expect(Object.values(LEGACY_FONT_IDS).every(v => !/http/i.test(v))).toBe(true)
  })
})
