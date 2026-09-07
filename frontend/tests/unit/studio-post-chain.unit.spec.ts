import { describe, it, expect } from 'vitest'
import { activePasses, bundledFragIds, passCountFor } from '~/lib/studio/post/chain'
import { DEFAULT_POST } from '~/lib/studio/post/settings'
import { POST_CHAIN_ORDER, POST_EFFECTS } from '~/lib/studio/post/manifest'
import shaderCatalog from '../../../shader_effects/manifest.json'

const catalogRecord = (id: string) =>
  (shaderCatalog as unknown as { effects: { id: string; passes?: number; params: { uniform: string }[] }[] })
    .effects.find(e => e.id === id)

describe('post pass selection', () => {
  it('selects nothing when every effect is off', () => {
    expect(activePasses(DEFAULT_POST)).toEqual([])
  })

  it('selects only the enabled effects', () => {
    const passes = activePasses({ ...DEFAULT_POST, bloom: true, vignette: true })
    expect(passes.map(p => p.id)).toEqual(['bloom', 'vignette'])
  })

  it('emits passes in chain order regardless of which were switched on first', () => {
    const passes = activePasses({ ...DEFAULT_POST, grain: true, color: true, bloom: true })
    const ids = passes.map(p => p.id)
    const expected = POST_CHAIN_ORDER.filter(id => ids.includes(id))
    expect(ids).toEqual(expected)
  })

  it('never selects a 3D-only effect for a flat host', () => {
    const passes = activePasses({ ...DEFAULT_POST, gtao: true }, { threeD: false })
    expect(passes.map(p => p.id)).not.toContain('gtao')
  })
})

// The chain used to restate each multi-pass effect's draw count in its own local
// map, which the catalog already declares. An effect added with passes > 1 and
// no entry in that second list would have rendered wrong — silently, since a
// half-run bloom still looks like something.
describe('pass counts come from the catalog', () => {
  it('matches shader_effects/manifest.json for every mapped frag', () => {
    for (const e of POST_EFFECTS) {
      if (!e.frag) continue
      const rec = catalogRecord(e.frag)
      expect(rec, `${e.id}: no catalog record for ${e.frag}`).toBeDefined()
      expect(passCountFor(e.frag), `${e.id} (${e.frag})`).toBe(rec!.passes ?? 1)
    }
  })

  it('still reports the two known multi-pass frags, and 1 for a single-pass one', () => {
    expect(passCountFor('bloom')).toBe(4)
    expect(passCountFor('gaussian_blur')).toBe(2)
    expect(passCountFor('post_grain')).toBe(1)
  })

  it('falls back to a single pass for an unknown frag rather than skipping the draw', () => {
    expect(passCountFor('not_a_catalog_effect')).toBe(1)
  })
})

// `fixed` pins a catalog uniform to a constant this stack needs but no user
// control owns — the third state alongside "user-facing control" and "catalog
// default". A typo'd uniform name is the failure mode worth catching here: at
// render time getUniformLocation just returns null and the pin silently does
// nothing, leaving the effect at the catalog default it was meant to override.
describe('fixed uniforms', () => {
  it('names a uniform the effect\'s own catalog record declares', () => {
    for (const e of POST_EFFECTS) {
      if (!e.fixed || !e.frag) continue
      const declared = (catalogRecord(e.frag)?.params ?? []).map(p => p.uniform)
      for (const name of Object.keys(e.fixed)) {
        expect(declared, `${e.id}: ${name} is not a uniform of ${e.frag}`).toContain(name)
      }
    }
  })

  it('never collides with a param the user controls', () => {
    for (const e of POST_EFFECTS) {
      if (!e.fixed) continue
      const userUniforms = e.params.map(p => p.uniform).filter(Boolean)
      for (const name of Object.keys(e.fixed)) {
        expect(userUniforms, `${e.id}: ${name} is both fixed and user-controlled`).not.toContain(name)
      }
    }
  })

  it('pins film\'s barrel warp and its own vignette off', () => {
    const film = POST_EFFECTS.find(e => e.id === 'film')!
    // Both are non-zero in the catalog — that is the whole point of pinning them.
    const defaults = Object.fromEntries((catalogRecord('crt_scanlines')!.params as unknown as { uniform: string; default: number }[]).map(p => [p.uniform, p.default]))
    expect(defaults.u_curvature).toBeGreaterThan(0)
    expect(defaults.u_vignette).toBeGreaterThan(0)
    expect(film.fixed).toEqual({ u_curvature: 0, u_vignette: 0 })
  })
})

// chain.ts's import.meta.glob names its frags one by one in a brace pattern (a
// '*' glob would inline all 68 catalog frags into the embed bundles — see the
// FRAG_MODULES comment there). That hardcoded list can drift from POST_EFFECTS
// in either direction; strict set equality catches both: a newly mapped effect
// whose frag was never added to the glob (would throw at render time), and a
// frag left in the glob after its effect was retired (dead bundle weight).
describe('bundled frag sources', () => {
  it('bundles exactly the frags POST_EFFECTS maps, nothing more or less', () => {
    const mapped = [...new Set(POST_EFFECTS.flatMap(e => (e.frag ? [e.frag] : [])))].sort()
    expect(bundledFragIds().sort()).toEqual(mapped)
  })
})
