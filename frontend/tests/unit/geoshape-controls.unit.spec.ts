import { describe, it, expect } from 'vitest'
import { GEO_CONTROLS, GEO_SECTIONS, visibleGeoControls, GEO_GUIDANCE } from '../../app/lib/geoshape/controls'
import { geoAgentControls } from '../../app/lib/geoshape/agentControls'
import { reroll } from '../../app/lib/geoshape/randomize'
import { DEFAULT_CONFIG, type GeoShapeConfig } from '../../app/lib/geoshape/config'
import { isShapeId } from '../../app/lib/shapes/catalog'

// Fields on GeoShapeConfig that are NOT a renderable control: `locks` is
// re-roll section-lock metadata, not a parameter a knob addresses. `fills`
// (the cycled-list counterpart of `fill`, used when `fillStrategy` !== 'single')
// and `overlapFills` (its `pieces`-mode overlap-palette counterpart) are each
// edited by a bespoke list editor (ShapeStudioSurface's fills-list block,
// mirroring SpaceTypeSurface's fillList pattern) rather than a single-value
// control row, so neither has a GEO_CONTROLS entry.
const NON_CONTROL_FIELDS = new Set(['locks', 'fills', 'overlapFills'])

const expectedKeys = Object.keys(DEFAULT_CONFIG).filter((k) => !NON_CONTROL_FIELDS.has(k))

describe('GEO_CONTROLS drift guard', () => {
  it('every user-facing GeoShapeConfig key has a control', () => {
    const controlKeys = new Set(GEO_CONTROLS.map((c) => c.key))
    const missing = expectedKeys.filter((k) => !controlKeys.has(k))
    expect(missing).toEqual([])
  })

  it('has no controls for keys that are not on GeoShapeConfig', () => {
    // Catches typo'd keys the agent could never actually write through.
    const known = new Set(expectedKeys)
    const stray = GEO_CONTROLS.map((c) => c.key).filter((k) => !known.has(k))
    expect(stray).toEqual([])
  })

  it('has unique keys', () => {
    const keys = GEO_CONTROLS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('GEO_SECTIONS integrity', () => {
  it('is non-empty', () => {
    expect(GEO_SECTIONS.length).toBeGreaterThan(0)
  })

  it('every control belongs to a declared section', () => {
    for (const c of GEO_CONTROLS) {
      expect(GEO_SECTIONS, `${c.key} group "${c.group}"`).toContain(c.group)
    }
  })

  it('every select default is one of its own options', () => {
    for (const c of GEO_CONTROLS) {
      if (c.kind !== 'select') continue
      expect(c.options, c.key).toContain(c.default)
    }
  })

  it('every slider default sits inside its own range', () => {
    for (const c of GEO_CONTROLS) {
      if (c.kind !== 'slider') continue
      expect(c.default, `${c.key} default`).toBeGreaterThanOrEqual(c.min)
      expect(c.default, `${c.key} default`).toBeLessThanOrEqual(c.max)
      expect(c.max, `${c.key} range`).toBeGreaterThan(c.min)
    }
  })
})

describe('visibleGeoControls follows the shape/layout/overlap/symmetry/clip predicates', () => {
  it('shows Sides for star/irregular (its meaning: points/vertex-count), hides it for fixed shapes', () => {
    for (const shape of ['star', 'irregular'] as const) {
      const keys = visibleGeoControls({ ...DEFAULT_CONFIG, shape }).map((c) => c.key)
      expect(keys, shape).toContain('sides')
    }
    for (const shape of ['hexagon', 'triangle', 'octagon', 'circle', 'leaf'] as const) {
      const keys = visibleGeoControls({ ...DEFAULT_CONFIG, shape }).map((c) => c.key)
      expect(keys, shape).not.toContain('sides')
    }
  })

  it('shows Star inner only for star, Irregular seed only for irregular', () => {
    const star = visibleGeoControls({ ...DEFAULT_CONFIG, shape: 'star' }).map((c) => c.key)
    expect(star).toContain('starInner')
    expect(star).not.toContain('irregularSeed')

    const irregular = visibleGeoControls({ ...DEFAULT_CONFIG, shape: 'irregular' }).map((c) => c.key)
    expect(irregular).toContain('irregularSeed')
    expect(irregular).not.toContain('starInner')
  })

  it('shows grid columns/rows only when layout is grid', () => {
    const grid = visibleGeoControls({ ...DEFAULT_CONFIG, layout: 'grid' }).map((c) => c.key)
    expect(grid).toContain('gridCols')
    expect(grid).toContain('gridRows')
    expect(grid).not.toContain('radius')

    const radial = visibleGeoControls({ ...DEFAULT_CONFIG, layout: 'radial' }).map((c) => c.key)
    expect(radial).not.toContain('gridCols')
    expect(radial).toContain('radius')
  })

  it('shows Overlap fill only when overlapMode is shape', () => {
    const shapeMode = visibleGeoControls({ ...DEFAULT_CONFIG, overlapMode: 'shape' }).map((c) => c.key)
    expect(shapeMode).toContain('overlapFill')
    const holeMode = visibleGeoControls({ ...DEFAULT_CONFIG, overlapMode: 'hole' }).map((c) => c.key)
    expect(holeMode).not.toContain('overlapFill')
  })

  it('shows symmetry axis/spacing only when symmetry is on', () => {
    const on = visibleGeoControls({ ...DEFAULT_CONFIG, symmetry: true }).map((c) => c.key)
    expect(on).toContain('symmetryAxis')
    expect(on).toContain('symmetrySpacing')
    const off = visibleGeoControls({ ...DEFAULT_CONFIG, symmetry: false }).map((c) => c.key)
    expect(off).not.toContain('symmetryAxis')
    expect(off).not.toContain('symmetrySpacing')
  })

  it('shows clip mask size only when a clip mask is chosen', () => {
    const clipped = visibleGeoControls({ ...DEFAULT_CONFIG, clipMask: 'circle' }).map((c) => c.key)
    expect(clipped).toContain('clipMaskSize')
    const none = visibleGeoControls({ ...DEFAULT_CONFIG, clipMask: 'none' }).map((c) => c.key)
    expect(none).not.toContain('clipMaskSize')
  })

  it('shows Colour order for perClone/pieces, hides for single', () => {
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'single' }).map(c => c.key)).not.toContain('fillOrder')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' }).map(c => c.key)).toContain('fillOrder')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'pieces' }).map(c => c.key)).toContain('fillOrder')
  })

  it('shows Separate overlap colours only for pieces', () => {
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'pieces' }).map(c => c.key)).toContain('overlapSeparate')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' }).map(c => c.key)).not.toContain('overlapSeparate')
  })

  it('shows Crossings only for pieces', () => {
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'pieces' }).map(c => c.key)).toContain('crossingMode')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' }).map(c => c.key)).not.toContain('crossingMode')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'single' }).map(c => c.key)).not.toContain('crossingMode')
  })

  it('shows single Fill only for single strategy', () => {
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'single' }).map(c => c.key)).toContain('fill')
    expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'pieces' }).map(c => c.key)).not.toContain('fill')
  })
  it('shows Composite fold controls (fillMode/overlapMode) only for single strategy', () => {
    // perClone/pieces return before the boolean fold, so these are inert there.
    for (const key of ['fillMode', 'overlapMode'] as const) {
      expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'single' }).map(c => c.key)).toContain(key)
      expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' }).map(c => c.key)).not.toContain(key)
      expect(visibleGeoControls({ ...DEFAULT_CONFIG, fillStrategy: 'pieces' }).map(c => c.key)).not.toContain(key)
    }
  })

  it('returns only members of GEO_CONTROLS', () => {
    const all = new Set(GEO_CONTROLS.map((c) => c.key))
    for (const c of visibleGeoControls(DEFAULT_CONFIG)) expect(all.has(c.key), c.key).toBe(true)
  })
})

describe('geoAgentControls', () => {
  it('emits plain ControlSpecs with no schema-only fields leaking', () => {
    for (const c of geoAgentControls(DEFAULT_CONFIG)) {
      expect(c, c.key).not.toHaveProperty('when')
      expect(c, c.key).not.toHaveProperty('agent')
      expect(c, c.key).not.toHaveProperty('animatable')
    }
  })

  it('guidance names only keys that exist in the schema', () => {
    const keys = new Set(GEO_CONTROLS.map((c) => c.key))
    // Extract candidates INDEPENDENTLY of `keys` — every multi-word control
    // field GEO_GUIDANCE names is written in camelCase (roundCorners,
    // starInner, gridCols, angleStep, rotateStep, scaleStart, fillMode,
    // overlapFill, symmetryAxis, clipMaskSize, strokeWidth, irregularSeed...),
    // and ordinary prose never coincidentally produces a lowercase-then-
    // uppercase token. So this regex is a real field-name detector: a typo'd
    // or dead/renamed field (e.g. "roundCornerz") gets pulled out as a
    // candidate and fails the membership check below. The old version
    // filtered candidates through `keys` before ever asserting membership,
    // so it could never fail no matter what the guidance said.
    const camelCaseToken = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/g
    const candidates = new Set(GEO_GUIDANCE.match(camelCaseToken) ?? [])
    // Sanity: the extraction actually found real field references, so an
    // empty `candidates` (e.g. from a broken regex) can't silently pass.
    expect(candidates.size).toBeGreaterThan(10)
    for (const c of candidates) expect(keys.has(c), c).toBe(true)
  })
})

describe('reroll', () => {
  const noLocks: Record<string, boolean> = {}

  it('produces a new seed', () => {
    const out = reroll(DEFAULT_CONFIG, noLocks)
    expect(out.seed).not.toBe(DEFAULT_CONFIG.seed)
  })

  it('is deterministic: the same cfg + locks always produces the same result', () => {
    const a = reroll(DEFAULT_CONFIG, noLocks)
    const b = reroll(DEFAULT_CONFIG, noLocks)
    expect(a).toEqual(b)
  })

  it('is deterministic starting from a different seed too', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG, seed: 4242 }
    const a = reroll(start, noLocks)
    const b = reroll(start, noLocks)
    expect(a).toEqual(b)
    expect(a.seed).not.toBe(4242)
  })

  it('a locked shape section is unchanged; unlocked sections change', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG, shape: 'star', sides: 9, starInner: 0.4 }
    const out = reroll(start, { shape: true })
    expect(out.shape).toBe(start.shape)
    expect(out.sides).toBe(start.sides)
    expect(out.starInner).toBe(start.starInner)
    expect(out.irregularSeed).toBe(start.irregularSeed)
    expect(out.size).toBe(start.size)
    expect(out.roundCorners).toBe(start.roundCorners)
    expect(out.roundRadius).toBe(start.roundRadius)
    // At least one unlocked section actually moved.
    const layoutChanged = out.layout !== start.layout || out.count !== start.count || out.radius !== start.radius
      || out.spacing !== start.spacing || out.angleStep !== start.angleStep
    expect(layoutChanged).toBe(true)
  })

  it('a locked layout section is unchanged when everything else is locked too', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG }
    const allLocked = { shape: true, layout: true, transform: true, composite: true, symmetry: true, clip: true, style: true }
    const out = reroll(start, allLocked)
    expect(out.layout).toBe(start.layout)
    expect(out.count).toBe(start.count)
    expect(out.gridCols).toBe(start.gridCols)
    expect(out.gridRows).toBe(start.gridRows)
    expect(out.radius).toBe(start.radius)
    expect(out.spacing).toBe(start.spacing)
    expect(out.angleStep).toBe(start.angleStep)
    expect(out.shape).toBe(start.shape)
    expect(out.rotateBase).toBe(start.rotateBase)
    expect(out.fillMode).toBe(start.fillMode)
    expect(out.symmetry).toBe(start.symmetry)
    expect(out.clipMask).toBe(start.clipMask)
    expect(out.padding).toBe(start.padding)
    // Even with everything locked, the seed still advances (a fresh re-roll
    // click always feels live) and paint is always carried through untouched.
    expect(out.seed).not.toBe(start.seed)
    expect(out.fill).toEqual(start.fill)
    expect(out.stroke).toEqual(start.stroke)
    expect(out.overlapFill).toEqual(start.overlapFill)
  })

  it('never rolls paint (fill/stroke/overlapFill), locked or not', () => {
    const start: GeoShapeConfig = { ...DEFAULT_CONFIG, fill: '#ff00aa', stroke: '#00ffaa', overlapFill: '#aabbcc' }
    const out = reroll(start, noLocks)
    expect(out.fill).toBe(start.fill)
    expect(out.stroke).toBe(start.stroke)
    expect(out.overlapFill).toBe(start.overlapFill)
  })

  it('stores the passed locks record onto the result', () => {
    const locks = { shape: true, style: false }
    const out = reroll(DEFAULT_CONFIG, locks)
    expect(out.locks).toEqual(locks)
  })
})

describe('library base shape controls', () => {
  it('shows the Library shape row only for the library kind, hides rounding under it', () => {
    const lib = { ...DEFAULT_CONFIG, shape: 'library' as const }
    const keys = (c: GeoShapeConfig) => visibleGeoControls(c).map(x => x.key)
    expect(keys(lib)).toContain('libraryShape')
    expect(keys(lib)).not.toContain('roundCorners')
    expect(keys(lib)).not.toContain('roundRadius')
    expect(keys(lib)).not.toContain('sides')
    expect(keys(DEFAULT_CONFIG)).not.toContain('libraryShape')
    expect(keys(DEFAULT_CONFIG)).toContain('roundCorners')
  })
  it('declares the row as a shape control without None and with sparkle as default', () => {
    const c = GEO_CONTROLS.find(x => x.key === 'libraryShape')!
    expect(c.kind).toBe('shape'); expect((c as any).allowNone).toBe(false); expect(c.default).toBe('sparkle'); expect(c.group).toBe('Shape')
  })
  it('guidance names the library family', () => {
    expect(GEO_GUIDANCE).toMatch(/library/)
  })
  it('re-roll yields a valid library id', () => {
    // reroll's real signature is (cfg, locks: Record<string, boolean>) — it
    // is pure w.r.t. cfg.seed, so vary the starting seed each iteration
    // rather than passing a seed string directly (see randomize.ts).
    const noLocks: Record<string, boolean> = {}
    for (let i = 0; i < 5; i++) {
      const start: GeoShapeConfig = { ...DEFAULT_CONFIG, seed: 1000 + i }
      const out = reroll(start, noLocks)
      expect(typeof out.libraryShape).toBe('string')
      expect(out.libraryShape.length).toBeGreaterThan(0)
      expect(isShapeId(out.libraryShape)).toBe(true)
    }
  })
})

describe('blend layout controls', () => {
  const keys = (c: GeoShapeConfig) => visibleGeoControls(c).map(x => x.key)

  it('the Blend group shows only in blend layout, and radius/spacing/stagger hide there', () => {
    const blend = keys({ ...DEFAULT_CONFIG, layout: 'blend' })
    for (const k of ['blendShape', 'blendSize', 'blendRotate', 'blendX', 'blendY', 'blendEase', 'blendTwist']) expect(blend).toContain(k)
    expect(blend).toContain('count')
    for (const k of ['radius', 'spacing', 'evenAngle', 'angleStep', 'stagger', 'spin']) expect(blend).not.toContain(k)
    const radial = keys({ ...DEFAULT_CONFIG, layout: 'radial' })
    expect(radial).not.toContain('blendShape')
  })

  it('shape B sub-controls follow B\'s kind like A\'s do', () => {
    const star = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'star' })
    expect(star).toContain('blendSides'); expect(star).toContain('blendStarInner'); expect(star).not.toContain('blendLibraryShape')
    const lib = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'library' })
    expect(lib).toContain('blendLibraryShape'); expect(lib).not.toContain('blendSides')
    const irr = keys({ ...DEFAULT_CONFIG, layout: 'blend', blendShape: 'irregular' })
    expect(irr).toContain('blendIrregularSeed'); expect(irr).toContain('blendSides')
  })

  it('Blend sits right after Layout in the section order', () => {
    expect(GEO_SECTIONS.indexOf('Blend')).toBe(GEO_SECTIONS.indexOf('Layout') + 1)
  })

  it('paintTarget always shows; fillCycle only with a multi-colour strategy', () => {
    const single = keys({ ...DEFAULT_CONFIG, fillStrategy: 'single' })
    expect(single).toContain('paintTarget'); expect(single).not.toContain('fillCycle')
    const per = keys({ ...DEFAULT_CONFIG, fillStrategy: 'perClone' })
    expect(per).toContain('fillCycle')
  })

  it('strokeWidth shows for an outline with no stroke colour set, and reaches hairlines', () => {
    const outline = visibleGeoControls({ ...DEFAULT_CONFIG, stroke: null, paintTarget: 'outline' })
    const sw = outline.find(c => c.key === 'strokeWidth')
    expect(sw).toBeDefined()
    expect((sw as any).step).toBe(0.25)
    expect(keys({ ...DEFAULT_CONFIG, stroke: null, paintTarget: 'fill' })).not.toContain('strokeWidth')
  })

  it('the layout select offers blend', () => {
    const layout = GEO_CONTROLS.find(c => c.key === 'layout') as any
    expect(layout.options).toContain('blend')
  })
})
