import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '../../shared/library-fonts'

const m = manifest as unknown as LibraryManifest

describe('Featured (bram-naus) foundry in the manifest', () => {
  it('registers the Featured foundry', () => {
    expect(m.foundries.find(f => f.id === 'bram-naus')).toEqual({ id: 'bram-naus', label: 'Featured' })
  })
  it('carries the google-source starter families with no faces', () => {
    const feat = m.families.filter(f => f.foundry === 'bram-naus')
    const sora = feat.find(f => f.family === 'Sora')
    expect(sora).toBeTruthy()
    expect(sora!.source).toBe('google')
    expect(sora!.googleFamily).toBe('Sora')
    expect(sora!.faces).toEqual([])
    expect(feat.map(f => f.family)).toEqual(expect.arrayContaining(['Sora', 'Lexend', 'Geologica', 'Onest', 'Syne']))
  })
})
