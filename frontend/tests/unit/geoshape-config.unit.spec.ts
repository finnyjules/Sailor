import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/geoshape/config'
import type { Paint } from '~/lib/compositor/paint'

describe('geoshape config', () => {
  it('mergeConfig on junk returns defaults', () => {
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig({ count: 'nope', layout: 'bogus' }).count).toBe(DEFAULT_CONFIG.count)
    expect(mergeConfig({ layout: 'bogus' }).layout).toBe(DEFAULT_CONFIG.layout)
  })
  it('round-trips a full config', () => {
    const cfg = { ...DEFAULT_CONFIG, count: 8, layout: 'grid' as const, overlapMode: 'shape' as const, seed: 42 }
    expect(mergeConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg)
  })
  it('defaults overlapMode to hole (geologo default)', () => {
    expect(DEFAULT_CONFIG.overlapMode).toBe('hole')
  })
  it('accepts a gradient Paint for fill and round-trips it', () => {
    const grad: Paint = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] }
    const cfg = mergeConfig({ ...DEFAULT_CONFIG, fill: grad })
    expect(cfg.fill).toEqual(grad)
  })
  it('accepts a pattern Fill and an ImageFill for fill', () => {
    const patt: any = { type: 'stripes', a: '#111', b: '#eee', textColor: '#000', angle: 0, density: 8 }
    const img: any = { type: 'image', src: 'data:image/png;base64,AAAA', fit: 'cover' }
    expect(mergeConfig({ ...DEFAULT_CONFIG, fill: patt }).fill).toEqual(patt)
    expect(mergeConfig({ ...DEFAULT_CONFIG, overlapFill: img }).overlapFill).toEqual(img)
  })
  it('falls back to default for junk paint (bad/absent type)', () => {
    expect(mergeConfig({ ...DEFAULT_CONFIG, fill: { type: 'bogus' } }).fill).toBe(DEFAULT_CONFIG.fill)
    expect(mergeConfig({ ...DEFAULT_CONFIG, fill: 42 }).fill).toBe(DEFAULT_CONFIG.fill)
  })
  it('a solid string stays a solid string', () => {
    expect(mergeConfig({ ...DEFAULT_CONFIG, fill: '#abcdef' }).fill).toBe('#abcdef')
  })
  it('fills round-trip; junk/empty fills → default non-empty', () => {
    const cfg = mergeConfig({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#f00', { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#0f0' }, { offset: 1, color: '#00f' }] }] })
    expect(cfg.fillStrategy).toBe('perClone')
    expect(cfg.fills).toHaveLength(2)
    expect(cfg.fills[0]).toBe('#f00')
    // junk/empty → falls back to the default non-empty list
    expect(mergeConfig({ ...DEFAULT_CONFIG, fills: [] }).fills).toEqual(DEFAULT_CONFIG.fills)
    expect(mergeConfig({ ...DEFAULT_CONFIG, fills: 'nope' }).fills).toEqual(DEFAULT_CONFIG.fills)
    expect(mergeConfig({ ...DEFAULT_CONFIG, fills: [42, { type: 'bogus' }] }).fills).toEqual(DEFAULT_CONFIG.fills) // all entries invalid → default
    // Mixed valid+invalid → keep ONLY the valid entries (must NOT collapse to
    // the whole default list — the drop-invalid arm, distinct from all-invalid).
    expect(mergeConfig({ ...DEFAULT_CONFIG, fills: ['#f00', 42, { type: 'bogus' }] }).fills).toEqual(['#f00'])
  })
  it('migrates legacy perShapeFill and honors explicit fillStrategy', () => {
    // Raw objects built WITHOUT `fillStrategy` (unlike a `{ ...DEFAULT_CONFIG }`
    // spread, which already carries `fillStrategy: 'single'` post-migration and
    // would mask `perShapeFill` under the "explicit wins" rule below) — these
    // stand in for a legacy persisted blob that predates this field.
    expect(mergeConfig({ perShapeFill: true }).fillStrategy).toBe('perClone')
    expect(mergeConfig({ perShapeFill: false }).fillStrategy).toBe('single')
    expect(mergeConfig({}).fillStrategy).toBe('single')
    expect(mergeConfig({ fillStrategy: 'pieces', perShapeFill: true }).fillStrategy).toBe('pieces')
    expect(mergeConfig({ fillStrategy: 'bogus' }).fillStrategy).toBe('single')
    expect(mergeConfig({ overlapFills: [] }).overlapFills).toEqual(DEFAULT_CONFIG.overlapFills)
    expect(mergeConfig({ fillOrder: 'rows' }).fillOrder).toBe('rows')
    expect(mergeConfig({ fillOrder: 'nope' }).fillOrder).toBe('created')
  })
  it('crossingMode round-trips and defaults to depth', () => {
    expect(mergeConfig({}).crossingMode).toBe('depth')
    expect(mergeConfig({ crossingMode: 'split' }).crossingMode).toBe('split')
    expect(mergeConfig({ crossingMode: 'nope' }).crossingMode).toBe('depth')
  })

  it('blend + paint fields default so an old document renders identically', () => {
    const cfg = mergeConfig({ shape: 'hexagon', count: 6 })
    expect(cfg.layout).toBe('radial')
    expect(cfg.blendShape).toBe('triangle')
    expect(cfg.blendLibraryShape).toBe(DEFAULT_CONFIG.blendLibraryShape)
    expect(cfg.blendSides).toBe(3)
    expect(cfg.blendStarInner).toBe(0.45)
    expect(cfg.blendIrregularSeed).toBe(1)
    expect(cfg.blendSize).toBe(180)
    expect(cfg.blendRotate).toBe(0)
    expect(cfg.blendX).toBe(0)
    expect(cfg.blendY).toBe(0)
    expect(cfg.blendEase).toBe('linear')
    expect(cfg.blendTwist).toBe(0)
    expect(cfg.fillCycle).toBe('cycle')
    expect(cfg.paintTarget).toBe('fill')
  })

  it('accepts layout blend and validates the blend enums', () => {
    expect(mergeConfig({ blendSize: 0 }).blendSize).toBe(0)
    expect(mergeConfig({ blendSize: -5 }).blendSize).toBe(0)
    const cfg = mergeConfig({ layout: 'blend', blendEase: 'easeInOut', fillCycle: 'ramp', paintTarget: 'outline', blendShape: 'star', blendLibraryShape: 'heart' })
    expect(cfg.layout).toBe('blend')
    expect(cfg.blendEase).toBe('easeInOut')
    expect(cfg.fillCycle).toBe('ramp')
    expect(cfg.paintTarget).toBe('outline')
    expect(cfg.blendShape).toBe('star')
    expect(cfg.blendLibraryShape).toBe('heart')
  })

  it('junk blend values fall back and numeric ranges clamp', () => {
    const cfg = mergeConfig({ blendEase: 'bouncy', fillCycle: 3, paintTarget: 'edges', blendShape: 'blob', blendLibraryShape: 'no-such-shape', blendSides: 99, blendTwist: 'x' })
    expect(cfg.blendEase).toBe('linear')
    expect(cfg.fillCycle).toBe('cycle')
    expect(cfg.paintTarget).toBe('fill')
    expect(cfg.blendShape).toBe('triangle')
    expect(cfg.blendLibraryShape).toBe(DEFAULT_CONFIG.blendLibraryShape)
    expect(cfg.blendSides).toBe(24)
    expect(cfg.blendTwist).toBe(0)
  })

  it('round-trips a blend config', () => {
    const cfg = { ...DEFAULT_CONFIG, layout: 'blend' as const, blendShape: 'circle' as const, blendSize: 240, blendX: 120, blendY: -40, blendTwist: 0.15, fillCycle: 'ramp' as const, paintTarget: 'outline' as const }
    expect(mergeConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg)
  })
})

describe('libraryShape', () => {
  it('defaults to sparkle and keeps a valid id', () => {
    expect(mergeConfig({}).libraryShape).toBe('sparkle')
    expect(mergeConfig({ libraryShape: 'sun-rays' }).libraryShape).toBe('sun-rays')
  })
  it('falls back on an unknown id and accepts the library kind', () => {
    expect(mergeConfig({ libraryShape: 'unicorn' }).libraryShape).toBe('sparkle')
    expect(mergeConfig({ shape: 'library' }).shape).toBe('library')
  })
})
