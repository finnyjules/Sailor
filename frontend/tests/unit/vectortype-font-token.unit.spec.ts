import { describe, expect, it } from 'vitest'
import { formatVtFontToken, isVtFontToken, parseVtFontToken, vtFontFileUrl, vtFontRefLabel } from '~/lib/vectortype/fontToken'
import manifest from '~/data/library-fonts.manifest.json'

describe('vector type font tokens', () => {
  it('parses the three shapes and rejects junk', () => {
    expect(parseVtFontToken('inter')).toEqual({ kind: 'catalog', id: 'inter' })
    expect(parseVtFontToken('google:Inter Tight@700')).toEqual({ kind: 'google', family: 'Inter Tight', weight: 700 })
    expect(parseVtFontToken('local:OT 2049@300')).toEqual({ kind: 'local', family: 'OT 2049', weight: 300, italic: false })
    expect(parseVtFontToken('local:OT 2049@300i')).toEqual({ kind: 'local', family: 'OT 2049', weight: 300, italic: true })
    expect(parseVtFontToken('local:OT 2049')).toEqual({ kind: 'local', family: 'OT 2049' })
    // A `local:` family is validated against the manifest, exactly as a bare id is
    // validated against the curated catalog — an unknown family is junk at PARSE time,
    // not a token that parses and then dead-ends at `vtFontFileUrl`.
    for (const bad of ['', 'nope', 'google:', 'google:Inter', 'google:Inter@abc', 'local:', 'local:No Such Family', 'local:No Such Family@400', 42, null, undefined, 'http://x'])
      expect(parseVtFontToken(bad)).toBeNull()
  })
  it('round-trips through format', () => {
    for (const t of ['inter', 'google:Inter Tight@700', 'local:OT 2049@300', 'local:OT 2049@300i', 'local:OT 2049'])
      expect(formatVtFontToken(parseVtFontToken(t)!)).toBe(t)
    expect(isVtFontToken('google:Inter Tight@700')).toBe(true)
    expect(isVtFontToken('unknown-id')).toBe(false)
  })
  it('maps each ref to its fail-closed route', () => {
    expect(vtFontFileUrl({ kind: 'catalog', id: 'inter' })).toBe('/api/fonts/variable?id=inter')
    expect(vtFontFileUrl({ kind: 'google', family: 'Inter Tight', weight: 700 })).toBe('/api/fonts/google-file?family=Inter%20Tight&weight=700')
    // the library resolves a family+weight to a face id through the manifest; an unknown family is null, never a guessed URL
    expect(vtFontFileUrl({ kind: 'local', family: 'No Such Family', weight: 400 })).toBeNull()
  })
  it('resolves a real local family from the manifest to its face route', () => {
    const family = manifest.families[0]!
    const face = family.faces[0]!
    expect(vtFontFileUrl({ kind: 'local', family: family.family, weight: face.weight })).toBe(`/api/library-font/${face.id}`)
  })
  it('labels read like a font menu', () => {
    expect(vtFontRefLabel({ kind: 'catalog', id: 'roboto-flex' })).toBe('Roboto Flex')
    expect(vtFontRefLabel({ kind: 'google', family: 'Inter Tight', weight: 700 })).toBe('Inter Tight 700')
  })
})
