import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { VT_TRACK_PRESETS, vtApplyTrackPreset, vtTrackPresetOffers } from '~/lib/vectortype/trackPresets'

describe('stretch motion presets', () => {
  const byId = (id: string) => VT_TRACK_PRESETS.find(p => p.id === id)!
  it('declares the three run-level presets', () => {
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const p = byId(id)
      expect(p).toBeDefined(); expect(p.kind).toBe('run'); expect(p.minLayers).toBe(0)
    }
  })
  it('Stretch In lands on the dial value (an entrance ends still)', () => {
    const tr = byId('stretch-in').build({ layers: [], duration: 2 })
    expect(tr).toHaveLength(1)
    expect(tr[0]!.path).toBe('stretch'); expect(tr[0]!.to).toBe(1); expect(tr[0]!.from).toBeGreaterThan(1)
    expect(tr[0]!.easing).toBe('easeinout')
  })
  it('Stretch Wave ping-pongs around 1, bounded to the proven single-axis range', () => {
    const tr = byId('stretch-wave').build({ layers: [], duration: 2 })
    expect(tr[0]!.path).toBe('stretch'); expect(tr[0]!.easing).toBe('pingpong'); expect(tr[0]!.loops).toBeGreaterThanOrEqual(2)
    expect(Math.min(tr[0]!.from, tr[0]!.to)).toBeGreaterThanOrEqual(0.8)
    expect(Math.max(tr[0]!.from, tr[0]!.to)).toBeLessThanOrEqual(1.3)
  })
  it('Spring Up is a height entrance that settles to 1', () => {
    const tr = byId('spring-up').build({ layers: [], duration: 2 })
    expect(tr[0]!.path).toBe('stretchY'); expect(tr[0]!.from).toBeGreaterThan(1.4); expect(tr[0]!.to).toBe(1)
  })
  it('each preset moves ONE dial and leaves the other at 1 (range policy)', () => {
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const paths = new Set(byId(id).build({ layers: [], duration: 2 }).map(t => t.path))
      expect(paths.has('stretch') && paths.has('stretchY')).toBe(false)
    }
  })
  it('run-level presets are offered and applicable with an EMPTY appearance stack', () => {
    const cfg = { ...DEFAULT_CONFIG, appearance: [] } as any
    const offers = vtTrackPresetOffers(cfg)
    for (const id of ['stretch-in', 'stretch-wave', 'spring-up']) {
      const o = offers.find(x => x.preset.id === id)!
      expect(o.available).toBe(true); expect(o.reason).toBeUndefined()
      const tracks = vtApplyTrackPreset(cfg, id)
      expect(tracks.some(t => t.path === 'stretch' || t.path === 'stretchY')).toBe(true)
    }
  })
})
