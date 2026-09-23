import { describe, it, expect } from 'vitest'
import { embedSurfaceKinds, isEmbeddable, loadEmbedSurface, bundleNameFor } from '~/lib/embed/surfaces'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects/index'

describe('embed surface registry', () => {
  it('lists shader as an embeddable kind', () => {
    expect(embedSurfaceKinds()).toContain('shader')
  })

  it('reports unknown kinds as not embeddable', () => {
    expect(isEmbeddable('shader')).toBe(true)
    expect(isEmbeddable('lipsync')).toBe(false)
    expect(isEmbeddable('')).toBe(false)
  })

  it('returns null for an unknown kind rather than throwing', async () => {
    await expect(loadEmbedSurface('nope')).resolves.toBeNull()
  })

  it('lists gradient as an embeddable kind', () => {
    expect(embedSurfaceKinds()).toContain('gradient')
  })

  it('loads the gradient surface with the right kind and declared caps', async () => {
    const s = await loadEmbedSurface('gradient')
    expect(s).not.toBeNull()
    expect(s!.kind).toBe('gradient')
    expect(typeof s!.caps.alpha).toBe('boolean')
  })

  it('lists spacetype as an embeddable kind', () => {
    expect(embedSurfaceKinds()).toContain('spacetype')
  })

  it('loads the spacetype surface with the right kind and genuine alpha support', async () => {
    const s = await loadEmbedSurface('spacetype')
    expect(s).not.toBeNull()
    expect(s!.kind).toBe('spacetype')
    // Unlike shader/gradient (both measured opaque), Space Type's engine is
    // constructed with alpha:true and genuinely clears to transparent when
    // opts.alpha is set (engine.ts's applyBackground) — the first real
    // consumer of EmbedCaps.alpha / EmbedSnapshot.transparent.
    expect(s!.caps.alpha).toBe(true)
  })
})

describe('bundleNameFor', () => {
  it('maps shader to its own bundle regardless of config', () => {
    expect(bundleNameFor('shader', {})).toBe('shader')
    expect(bundleNameFor('shader', { anything: 'goes' })).toBe('shader')
  })

  it('maps gradient to its own bundle regardless of config', () => {
    expect(bundleNameFor('gradient', {})).toBe('gradient')
  })

  it('maps spacetype to the per-effect bundle named after config.effectId', () => {
    expect(bundleNameFor('spacetype', { effectId: 'ball' })).toBe('spacetype-ball')
    expect(bundleNameFor('spacetype', { effectId: 'cornerpin' })).toBe('spacetype-cornerpin')
  })

  it('resolves every registered Space Type effect to its own bundle name', () => {
    for (const effect of SPACE_TYPE_EFFECTS) {
      expect(bundleNameFor('spacetype', { effectId: effect.id })).toBe(`spacetype-${effect.id}`)
    }
  })

  it('is case-insensitive on effectId, matching the embed adapter\'s own lookup', () => {
    expect(bundleNameFor('spacetype', { effectId: 'BALL' })).toBe('spacetype-ball')
  })

  it('throws on a missing effectId rather than falling back to a generic bundle', () => {
    expect(() => bundleNameFor('spacetype', {})).toThrow()
    expect(() => bundleNameFor('spacetype', { effectId: '' })).toThrow()
    expect(() => bundleNameFor('spacetype', null)).toThrow()
  })

  // The failure mode this whole feature exists to prevent: a wrong-but-plausible
  // fallback bundle. A weaker implementation might return a default effect's
  // bundle (e.g. the first in SPACE_TYPE_EFFECTS) instead of throwing — this
  // would still resolve to SOME real spacetype-*.js file and render something
  // that looks fine, just for the wrong effect. Asserting a throw, not merely
  // "does not equal spacetype-ball", is what catches that implementation.
  it('throws on an unknown effectId rather than substituting a default effect', () => {
    expect(() => bundleNameFor('spacetype', { effectId: 'not-a-real-effect' })).toThrow()
    // Specifically must not silently resolve to the first registered effect.
    let thrown = false
    try {
      bundleNameFor('spacetype', { effectId: 'not-a-real-effect' })
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
  })

  // Path traversal: this value reaches a URL (`/embed/${bundle}.js`). A pattern
  // match for ".." would be brittle (a same-directory variant, e.g. a bare
  // absolute path or a percent-encoded segment, could slip past it); validating
  // against the real effect list rejects it for the same reason "banana" is
  // rejected — it simply is not a registered effect id — so this test would
  // fail against an implementation that merely greps for "..".
  it('rejects path traversal in effectId rather than pattern-matching for ".."', () => {
    expect(() => bundleNameFor('spacetype', { effectId: '../../etc/passwd' })).toThrow()
    expect(() => bundleNameFor('spacetype', { effectId: '..%2f..%2fetc%2fpasswd' })).toThrow()
    expect(() => bundleNameFor('spacetype', { effectId: '/etc/passwd' })).toThrow()
    expect(() => bundleNameFor('spacetype', { effectId: 'ball/../../../etc/passwd' })).toThrow()
  })

  // R14e: 'frame' picks 'frame-lean' ONLY on an explicit `needsOutlines === false` — every other
  // shape of config falls back to the full, safe 'frame'. A permissive `needsOutlines ?
  // 'frame' : 'frame-lean'` would pick lean for a MISSING field (undefined is falsy) too, which
  // is exactly the "still Frame draws unclipped" failure mode this fix round exists to close.
  it('maps frame to frame-lean only on an explicit needsOutlines: false', () => {
    expect(bundleNameFor('frame', { needsOutlines: false })).toBe('frame-lean')
  })

  it('maps frame to the full bundle on needsOutlines: true', () => {
    expect(bundleNameFor('frame', { needsOutlines: true })).toBe('frame')
  })

  it('maps frame to the full bundle when needsOutlines is missing, not to frame-lean', () => {
    expect(bundleNameFor('frame', {})).toBe('frame')
  })

  it('maps frame to the full bundle for a null or non-object config, not to frame-lean', () => {
    expect(bundleNameFor('frame', null)).toBe('frame')
    expect(bundleNameFor('frame', undefined)).toBe('frame')
  })

  it('maps frame to the full bundle for a truthy-but-not-boolean needsOutlines, not to frame-lean', () => {
    expect(bundleNameFor('frame', { needsOutlines: 'false' })).toBe('frame')
    expect(bundleNameFor('frame', { needsOutlines: 0 })).toBe('frame')
  })
})
