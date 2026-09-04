import { describe, it, expect } from 'vitest'
import {
  LAYER_MAX, newLayerId, mergeLayer, mergeStudioDoc, defaultDoc, defaultOverlap,
  studioDocFromPersisted,
} from '~/lib/geoshape/studio'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/geoshape/config'

describe('geoshape studio doc', () => {
  it('defaultDoc is a single enabled layer, overlap off', () => {
    const d = defaultDoc()
    expect(d.layers).toHaveLength(1)
    expect(d.layers[0]!.enabled).toBe(true)
    expect(d.overlap.enabled).toBe(false)
    expect(d.padding).toBe(DEFAULT_CONFIG.padding)
  })

  it('newLayerId returns distinct ids', () => {
    const a = newLayerId(); const b = newLayerId()
    expect(a).not.toBe(b)
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(1)
  })

  it('mergeLayer defends junk and mints a missing id', () => {
    const l = mergeLayer({ enabled: 'nope', opacity: 5, offset: { x: 'q' }, blend: 'bogus' })
    expect(typeof l.layerId).toBe('string')
    expect(l.layerId.length).toBeGreaterThan(1)
    expect(l.enabled).toBe(true)          // non-bool -> default true
    expect(l.opacity).toBe(1)             // clamped into [0,1]
    expect(l.offset).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
    expect(l.blend).toBe('normal')        // unknown blend -> normal
    // mark is a full valid GeoShapeConfig
    expect(l.mark.shape).toBe(DEFAULT_CONFIG.shape)
  })

  it('mergeLayer preserves a valid id and offset', () => {
    const l = mergeLayer({ layerId: 'keep-me', offset: { x: 10, y: -20, scale: 2, rotate: 45 } })
    expect(l.layerId).toBe('keep-me')
    expect(l.offset).toEqual({ x: 10, y: -20, scale: 2, rotate: 45 })
  })

  it('mergeStudioDoc clamps to 1..LAYER_MAX layers', () => {
    const many = mergeStudioDoc({ layers: Array.from({ length: LAYER_MAX + 4 }, () => ({})) })
    expect(many.layers).toHaveLength(LAYER_MAX)
    const none = mergeStudioDoc({ layers: [] })
    expect(none.layers).toHaveLength(1)           // empty -> a default layer
    const notArr = mergeStudioDoc({ layers: 'x' })
    expect(notArr.layers).toHaveLength(1)
  })

  it('mergeStudioDoc keeps overlap fills non-empty', () => {
    expect(mergeStudioDoc({ overlap: { fills: [] } }).overlap.fills.length).toBeGreaterThan(0)
    expect(mergeStudioDoc({ overlap: { fills: ['#abc123', '#def456'] } }).overlap.fills).toEqual(['#abc123', '#def456'])
    expect(defaultOverlap().fills.length).toBeGreaterThan(0)
  })

  // ── Migration: legacy single-mark blob must become a one-layer doc that is
  //    byte-for-byte the SAME MARK as the flat studio produced (no regression). ──
  it('studioDocFromPersisted migrates a legacy {config} blob into one identical layer', () => {
    const legacyMark = { ...DEFAULT_CONFIG, shape: 'star', sides: 7, size: 240, padding: 12, seed: 99 }
    const doc = studioDocFromPersisted({ config: legacyMark, canvasW: 800, canvasH: 800 })
    expect(doc.layers).toHaveLength(1)
    expect(doc.overlap.enabled).toBe(false)
    // The single layer's mark equals mergeConfig(legacy) exactly (minus the id, which is fresh).
    expect(doc.layers[0]!.mark).toEqual(mergeConfig(legacyMark))
    // Padding + seed lifted from the mark to the stack.
    expect(doc.padding).toBe(12)
    expect(doc.seed).toBe(99)
    // Native placement / opaque.
    expect(doc.layers[0]!.offset).toEqual({ x: 0, y: 0, scale: 1, rotate: 0 })
    expect(doc.layers[0]!.opacity).toBe(1)
    expect(doc.layers[0]!.blend).toBe('normal')
  })

  it('studioDocFromPersisted validates a modern {doc} blob straight through', () => {
    const doc0 = mergeStudioDoc({ layers: [{ layerId: 'a' }, { layerId: 'b' }], overlap: { enabled: true } })
    const round = studioDocFromPersisted({ doc: doc0 })
    expect(round.layers.map((l) => l.layerId)).toEqual(['a', 'b'])
    expect(round.overlap.enabled).toBe(true)
  })

  it('studioDocFromPersisted returns a default doc for an empty/garbage blob', () => {
    expect(studioDocFromPersisted(undefined).layers).toHaveLength(1)
    expect(studioDocFromPersisted({}).layers).toHaveLength(1)
    expect(studioDocFromPersisted({ nonsense: 1 }).layers).toHaveLength(1)
  })
})

describe('GeoStudioDoc background', () => {
  it('defaults a missing background to null (transparent)', () => {
    expect(mergeStudioDoc({ layers: [] }).background).toBeNull()
    expect(defaultDoc().background).toBeNull()
  })

  it('collapses the none-sentinels to null', () => {
    expect(mergeStudioDoc({ background: 'none' }).background).toBeNull()
    expect(mergeStudioDoc({ background: '' }).background).toBeNull()
    expect(mergeStudioDoc({ background: null }).background).toBeNull()
  })

  it('round-trips a solid-colour background', () => {
    expect(mergeStudioDoc({ background: '#112233' }).background).toBe('#112233')
  })

  it('round-trips a gradient background object', () => {
    const g = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
    expect(mergeStudioDoc({ background: g }).background).toEqual(g)
  })

  it('migrates a legacy single-mark blob with a null background', () => {
    // studioDocFromPersisted is already imported by this suite for other tests.
    expect(studioDocFromPersisted({ config: { shape: 'hexagon' } }).background).toBeNull()
  })
})
