import { describe, it, expect } from 'vitest'
import { resolveLibraryFaceByFamily, contentTypeForPath } from '../../server/utils/libraryFontManifest'
import manifest from '../../app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '../../shared/library-fonts'

const m = manifest as unknown as LibraryManifest
const ROOT = '/fonts-root'
const MORI = m.families.find(f => f.family === 'PP Mori')!

describe('resolveLibraryFaceByFamily', () => {
  it('resolves a known family+weight to a .otf path ending in the face src', () => {
    const regular = MORI.faces.find(f => f.weight === 400 && !f.italic)!
    const r = resolveLibraryFaceByFamily('PP Mori', 400, false, ROOT)
    expect(r).not.toBeNull()
    expect(r!.path).toBe(`${ROOT}/${regular.src}`)
    expect(r!.path.endsWith('.otf')).toBe(true)
    expect(r!.weight).toBe(400)
    expect(r!.italic).toBe(false)
  })

  it('falls back to the nearest weight for an off-scale request', () => {
    // 550 sits 50 away from 600 (Semibold) and 150 away from 400 (Regular).
    const semibold = MORI.faces.find(f => f.weight === 600 && !f.italic)!
    const r = resolveLibraryFaceByFamily('PP Mori', 550, false, ROOT)
    expect(r).not.toBeNull()
    expect(r!.path).toBe(`${ROOT}/${semibold.src}`)
    expect(r!.weight).toBe(600)
  })

  it('honours italic', () => {
    const italic = MORI.faces.find(f => f.weight === 400 && f.italic)!
    const r = resolveLibraryFaceByFamily('PP Mori', 400, true, ROOT)
    expect(r).not.toBeNull()
    expect(r!.path).toBe(`${ROOT}/${italic.src}`)
    expect(r!.italic).toBe(true)
  })

  it('returns null for an unknown family', () => {
    expect(resolveLibraryFaceByFamily('Not A Real Family', 400, false, ROOT)).toBeNull()
  })
})

describe('contentTypeForPath', () => {
  it('serves .otf as font/otf', () => {
    expect(contentTypeForPath('/x/Regular.otf')).toBe('font/otf')
  })
  it('serves .woff2 as font/woff2', () => {
    expect(contentTypeForPath('/x/Regular.woff2')).toBe('font/woff2')
  })
  it('serves .ttf as font/ttf', () => {
    expect(contentTypeForPath('/x/Regular.ttf')).toBe('font/ttf')
  })
  it('defaults unknown extensions to font/otf', () => {
    expect(contentTypeForPath('/x/Regular.weird')).toBe('font/otf')
  })
})
