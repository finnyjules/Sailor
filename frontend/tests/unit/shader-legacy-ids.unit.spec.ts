import { describe, it, expect } from 'vitest'
import catalogJson from '../../../shader_effects/manifest.json'
import { LEGACY_EFFECT_IDS, resolveEffectId } from '~/lib/shaderfx/catalog'

const ids = new Set((catalogJson as { effects: { id: string }[] }).effects.map(e => e.id))

describe('legacy shader effect ids', () => {
  it('every alias points at a real catalog effect and never at another alias', () => {
    for (const [from, to] of Object.entries(LEGACY_EFFECT_IDS)) {
      expect(ids.has(to), `${from} → ${to} is not in the catalog`).toBe(true)
      expect(LEGACY_EFFECT_IDS[to]).toBeUndefined()
      expect(ids.has(from), `${from} is still a live id; the alias is stale`).toBe(false)
    }
  })
  it('resolves filament to thread_contours and leaves live ids alone', () => {
    expect(resolveEffectId('filament')).toBe('thread_contours')
    expect(resolveEffectId('aurora')).toBe('aurora')
  })
})
