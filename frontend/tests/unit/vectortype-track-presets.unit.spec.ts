/**
 * Vector Type — the two APPEARANCE-STACK motions the studio already had, and
 * the one it did not.
 *
 * This spec is a MEASUREMENT before it is a regression test. The plan claimed
 * two effects might already work for free, on the strength of the studio's own
 * guarantee (`f(cfg, t) → paths`, so every declared slider is animatable). One
 * did; the other could not, for a structural reason worth pinning so it does not
 * get re-attempted:
 *
 *  1. **The extrude light sweep works, and the shadow really orbits.** Not
 *     "the config value changed" — the ink moves. The extrude layer is painted
 *     RED and rasterised with resvg at eight points around the turn, and its ink
 *     CENTROID traces a circle 56 px across at `depth 6 × distance 8`, which is
 *     exactly twice the mean copy offset (3.5 × 8 = 28). A second, independent
 *     metric rides along — the ink XOR against frame 0 — because a centroid
 *     alone can be moved by an occlusion change, and a config-value assertion is
 *     blind to geometry entirely.
 *
 *     The BROKEN CONTROL is the same config with the track removed: XOR 0.0000
 *     and a centroid that does not move by a thousandth of a pixel. Without it,
 *     "the pixels differ" would not distinguish the sweep from the renderer
 *     being non-deterministic.
 *
 *  2. **There is no per-layer glyph offset, so the plan's misregistration does
 *     not exist.** `glyph.dx`/`dy` are a per-GLYPH namespace shared by the whole
 *     appearance stack — `frame.transforms[i]` is resolved once and every layer
 *     paints under it — so two fill layers cannot drift apart with them. Three
 *     facts are asserted, not one, because each alone reads as a fixable bug:
 *     `animatableTargets` never offers such a path, `applyMotion` refuses to
 *     fabricate the container, and two opposed `glyph.dx` tracks compose to the
 *     SECOND one alone rather than to their sum.
 *
 *  3. **The look is reachable a different way**, and the preset takes that way:
 *     two depth-1 extrude layers at opposite angles, with `distance` animated.
 *     Measured plate-to-plate separation is exactly `2 × distance` — 0, 14, 28 —
 *     with each plate rasterised on its own so occlusion cannot flatter it.
 *
 * NO NETWORK: the same eight-character Inter variable subset every other Vector
 * Type spec uses. The rasteriser is `@resvg/resvg-js`, already a dependency, so
 * "pixels" here are real pixels and not a canvas recorder's opinion.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it, vi } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtMotionTrack,
} from '~/lib/vectortype/config'
import { vectorTypeSVG } from '~/lib/vectortype/canvas'
import { animatableTargets, applyMotion, glyphTransform } from '~/lib/vectortype/motion'
import {
  VT_MISREGISTRATION_DRIFT,
  VT_TRACK_PRESETS,
  vtApplyTrackPreset,
  vtTrackPreset,
  vtTrackPresetActive,
  vtTrackPresetOffer,
  vtTrackPresetOffers,
} from '~/lib/vectortype/trackPresets'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const W = 520
const H = 300

// Every claim here is measured on a real raster, and a dozen 520×300 resvg
// renders do not fit the suite's 5 s default when the whole suite is running in
// parallel. Raised rather than the pictures made smaller: the metrics are
// pixel counts and sub-pixel centroids, and shrinking the frame would blunt
// exactly the thing being measured.
vi.setConfig({ testTimeout: 30_000 })

const paint = (a: string) => ({ ...DEFAULT_CONFIG.appearance[0]!.paint, type: 'solid' as const, a })
const layer = (o: Partial<VtAppearanceLayer>): VtAppearanceLayer => vtLayer(o)
const cfg = (patch: Partial<VectorTypeConfig>): VectorTypeConfig =>
  mergeConfig({ ...DEFAULT_CONFIG, text: 'Sail', size: 100, ...patch })
const track = (o: Partial<VtMotionTrack> & { path: string; from: number; to: number }): VtMotionTrack =>
  ({ easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...o })

// ── the measurement harness ─────────────────────────────────────────────────

interface Ink {
  /** One bit per pixel, so two frames can be XOR'd. */
  bits: Uint8Array
  /** Pixel count. */
  n: number
  cx: number
  cy: number
}

/** Rasterise one exported frame and reduce the pixels matching `keep` to a mask
 *  plus its centroid. Real pixels: resvg, at 1:1 with the document. */
function ink(svg: string, keep: (r: number, g: number, b: number) => boolean): Ink {
  const img = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
  const px = img.pixels
  const total = img.width * img.height
  const bits = new Uint8Array(total)
  let n = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < total; i++) {
    if (px[i * 4 + 3]! > 40 && keep(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!)) {
      bits[i] = 1
      n++
      sx += i % img.width
      sy += Math.floor(i / img.width)
    }
  }
  return { bits, n, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN }
}

const RED = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100
const BLUE = (r: number, g: number, b: number) => b > 150 && r < 100 && g < 100

/** Symmetric difference over union — the geometry metric a centroid cannot
 *  fake and a `core %` style comparison is blind to. */
function inkXor(a: Ink, b: Ink): number {
  let diff = 0
  let union = 0
  for (let i = 0; i < a.bits.length; i++) {
    const x = a.bits[i]!
    const y = b.bits[i]!
    if (x !== y) diff++
    if (x || y) union++
  }
  return union ? diff / union : 0
}

const frameAt = (c: VectorTypeConfig, t: number): string =>
  vectorTypeSVG(font, c, t, { width: W, height: H, background: '#ffffff' }).svg

/** One extrude layer under a face, with the layer's angle animated a full turn. */
function sweepConfig(over: Partial<VtAppearanceLayer> = {}): VectorTypeConfig {
  const ext = layer({ id: 'Lext', kind: 'extrude', depth: 6, distance: 8, taper: 0, angle: 0, paint: paint('#ff0000'), ...over })
  return cfg({
    appearance: [ext, layer({ id: 'Lface', kind: 'fill', paint: paint('#0000ff') })],
    motion: { ...DEFAULT_CONFIG.motion, duration: 8, tracks: [] },
  })
}

// ── 1. the sweep, measured ──────────────────────────────────────────────────

describe('extrude light sweep — already free, and the shadow really moves', () => {
  const swept = (): VectorTypeConfig => {
    const c = sweepConfig()
    return mergeConfig({ ...c, motion: { ...c.motion, tracks: vtApplyTrackPreset(c, 'extrude-sweep') } })
  }

  it('sweeps the layer leaf through a full turn without touching the face', () => {
    const c = swept()
    expect(c.motion.tracks.map(t => t.path)).toEqual(['appearance.Lext.angle'])
    const angles = [0, 2, 4, 6].map(t => Math.round((applyMotion(c, t).appearance[0] as VtAppearanceLayer).angle))
    expect(angles).toEqual([0, 90, 180, 270])
    // The FACE is untouched: a sweep moves the light, not the word.
    for (const t of [0, 2, 4, 6]) {
      expect(applyMotion(c, t).appearance[1]).toEqual(c.appearance[1])
    }
  })

  it('moves the shadow ink around the word — centroid AND ink XOR', () => {
    const c = swept()
    const frames = [0, 1, 2, 3, 4, 5].map(t => ink(frameAt(c, t), RED))
    expect(frames.every(f => f.n > 0)).toBe(true)

    const xs = frames.map(f => f.cx)
    const ys = frames.map(f => f.cy)
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanY = Math.max(...ys) - Math.min(...ys)
    // Measured 69.62 × 72.19 px with the face occluding part of the block. A
    // shadow that merely flickered in place would move the centroid by a pixel
    // or two; a whole letterform is ~60 px wide here.
    expect(spanX).toBeGreaterThan(40)
    expect(spanY).toBeGreaterThan(40)

    // GEOMETRY, not just position. Measured 0.520–0.858 against frame 0.
    const xors = frames.slice(1).map(f => inkXor(frames[0]!, f))
    expect(Math.min(...xors)).toBeGreaterThan(0.3)

    // Opposite ends of the turn mirror each other about the word: 0° steps
    // right, 180° steps left, by construction of the angle convention.
    expect(frames[0]!.cx).toBeGreaterThan(frames[4]!.cx)
    expect(Math.abs(frames[0]!.cy - frames[4]!.cy)).toBeLessThan(1)
  })

  it('BROKEN CONTROL — the same config with no track does not move at all', () => {
    const still = sweepConfig()
    const a = ink(frameAt(still, 0), RED)
    const b = ink(frameAt(still, 4), RED)
    expect(a.n).toBeGreaterThan(0)
    expect(inkXor(a, b)).toBe(0)
    expect(b.cx - a.cx).toBe(0)
  })

  it('the turn is seamless — the last frame is the first frame', () => {
    const c = swept()
    const start = applyMotion(c, 0).appearance[0] as VtAppearanceLayer
    const end = applyMotion(c, c.motion.duration).appearance[0] as VtAppearanceLayer
    expect(((end.angle % 360) + 360) % 360).toBeCloseTo(((start.angle % 360) + 360) % 360, 6)
  })
})

// ── 2. the misregistration that is NOT expressible ──────────────────────────

describe('per-layer glyph offsets do not exist — three ways of saying so', () => {
  const twoFills = (tracks: VtMotionTrack[]): VectorTypeConfig => cfg({
    appearance: [
      layer({ id: 'Lred', kind: 'fill', paint: paint('#ff0000') }),
      layer({ id: 'Lblue', kind: 'fill', paint: paint('#0000ff') }),
    ],
    motion: { ...DEFAULT_CONFIG.motion, duration: 4, tracks },
  })

  it('no such path is ever offered as a target', () => {
    const c = twoFills([])
    const paths = animatableTargets(c, font.axes).map(t => t.path)
    expect(paths.filter(p => p.includes('glyph'))).toEqual([
      'glyph.dx', 'glyph.dy', 'glyph.scale', 'glyph.rotate', 'glyph.opacity',
    ])
    expect(paths.some(p => p.startsWith('appearance.') && p.includes('.glyph.'))).toBe(false)
  })

  it('applyMotion refuses to fabricate the container rather than growing junk', () => {
    const c = twoFills([
      track({ path: 'appearance.Lred.glyph.dx', from: -14, to: 14 }),
      track({ path: 'appearance.Lblue.glyph.dx', from: 14, to: -14 }),
    ])
    const out = applyMotion(c, 2)
    expect((out.appearance[0] as Record<string, unknown>).glyph).toBeUndefined()
    expect((out.appearance[1] as Record<string, unknown>).glyph).toBeUndefined()
    // And in pixels: the two coincident fills never separate, so the LOWER one
    // is 100 % occluded at every instant of the clip.
    for (const t of [0, 2, 4]) {
      expect(ink(frameAt(c, t), RED).n).toBe(0)
    }
    const cxs = [0, 2, 4].map(t => ink(frameAt(c, t), BLUE).cx)
    expect(cxs[0]).toBe(cxs[1])
    expect(cxs[1]).toBe(cxs[2])
  })

  it('two opposed glyph.dx tracks are the SECOND one, not their sum', () => {
    // The namespace that does exist is per-GLYPH and shared by the whole stack,
    // and `glyphTransform` assigns rather than accumulates — so "in opposition"
    // is not a thing two tracks on one channel can be.
    const c = twoFills([
      track({ path: 'glyph.dx', from: -14, to: 14 }),
      track({ path: 'glyph.dx', from: 14, to: -14 }),
    ])
    expect(glyphTransform(c, 0, 0, 4).dx).toBe(14)
    expect(glyphTransform(c, 4, 0, 4).dx).toBe(-14)
    // The whole run moves together; the bottom layer is still fully covered.
    for (const t of [0, 2, 4]) expect(ink(frameAt(c, t), RED).n).toBe(0)
  })
})

// ── 3. the misregistration that IS expressible ──────────────────────────────

describe('misregistration as opposed extrude plates', () => {
  const plates = (): VectorTypeConfig => cfg({
    appearance: [
      layer({ id: 'Lc', kind: 'extrude', depth: 1, distance: 14, taper: 0, angle: 180, paint: paint('#ff0000') }),
      layer({ id: 'Lm', kind: 'extrude', depth: 1, distance: 14, taper: 0, angle: 0, paint: paint('#0000ff') }),
      // SATURATED, so Colour Cycle accepts it too — a near-black face has no hue
      // to rotate and the preset would (correctly) refuse it.
      layer({ id: 'Lface', kind: 'fill', paint: paint('#cc2200') }),
    ],
    motion: { ...DEFAULT_CONFIG.motion, duration: 4, tracks: [] },
  })
  const applied = (): VectorTypeConfig => {
    const c = plates()
    return mergeConfig({ ...c, motion: { ...c.motion, tracks: vtApplyTrackPreset(c, 'misregistration') } })
  }

  it('drives every plate from zero to the offset the user already chose', () => {
    const c = applied()
    expect(c.motion.tracks).toEqual([
      track({ path: 'appearance.Lc.distance', from: 0, to: 14, easing: 'pingpong' }),
      track({ path: 'appearance.Lm.distance', from: 0, to: 14, easing: 'pingpong' }),
    ])
  })

  it('separates the plates by exactly twice the distance, measured alone', () => {
    const c = applied()
    // Each plate rasterised on its OWN, so the separation is the geometry and
    // not an artefact of which plate is painted last.
    const solo = (i: number): VectorTypeConfig => mergeConfig({ ...c, appearance: [c.appearance[i]!] })
    const red = solo(0)
    const blue = solo(1)
    const seen: { d: number; sep: number }[] = []
    for (const t of [0, 1, 2]) {
      const d = (applyMotion(c, t).appearance[0] as VtAppearanceLayer).distance
      seen.push({ d, sep: ink(frameAt(blue, t), BLUE).cx - ink(frameAt(red, t), RED).cx })
    }
    expect(seen.map(s => s.d)).toEqual([0, 7, 14])
    for (const s of seen) expect(s.sep).toBeCloseTo(2 * s.d, 6)
  })

  it('a single plate is a slide rather than a split, and still animates', () => {
    const one = cfg({
      appearance: [
        layer({ id: 'Lc', kind: 'extrude', depth: 1, distance: 0, taper: 0, angle: 0, paint: paint('#ff0000') }),
        layer({ id: 'Lface', kind: 'fill', paint: paint('#111111') }),
      ],
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, tracks: [] },
    })
    const c = mergeConfig({ ...one, motion: { ...one.motion, tracks: vtApplyTrackPreset(one, 'misregistration') } })
    // With no offset set, the declared default is what it reaches for.
    expect(c.motion.tracks[0]!.to).toBe(VT_MISREGISTRATION_DRIFT)
    const registered = ink(frameAt(c, 0), RED).n
    const drifted = ink(frameAt(c, 2), RED).n
    // In register the plate is hidden behind the face — what survives is the
    // antialiased hairline along the outline, a couple of dozen pixels at most.
    expect(drifted).toBeGreaterThan(500)
    expect(registered).toBeLessThan(drifted / 50)
  })
})

// ── 4. the table itself ─────────────────────────────────────────────────────

describe('the track-preset table', () => {
  it('declares a frame and derives the rest', () => {
    expect(VT_TRACK_PRESETS.map(p => p.id)).toEqual([
      'extrude-sweep', 'misregistration', 'colour-cycle',
      // RUN-LEVEL — no layer to find, so `minLayers` is 0, not "greater than
      // 0" like every layer-addressed preset above.
      'stretch-in', 'stretch-wave', 'spring-up',
    ])
    for (const p of VT_TRACK_PRESETS) {
      expect(p.label.trim()).not.toBe('')
      expect(p.pitch.trim()).not.toBe('')
      if (p.kind === 'run') expect(p.minLayers).toBe(0)
      else expect(p.minLayers).toBeGreaterThan(0)
    }
    expect(vtTrackPreset('extrude-sweep')?.kind).toBe('extrude')
    // Not every preset drives an extrude any more — Colour Cycle drives a FILL,
    // which is what made the reason sentence's article derived rather than fixed.
    expect(vtTrackPreset('colour-cycle')?.kind).toBe('fill')
    expect(vtTrackPreset('stretch-in')?.kind).toBe('run')
    expect(vtTrackPreset('nope')).toBeNull()
    expect(vtTrackPreset(undefined)).toBeNull()
  })

  it('is NON-VACUOUS — every preset emits at least one track on a stack it accepts', () => {
    const c = plentiful()
    for (const p of VT_TRACK_PRESETS) {
      const offer = vtTrackPresetOffer(p, c)
      expect(offer.available).toBe(true)
      expect(p.build({ layers: offer.layers, duration: c.motion.duration }).length).toBeGreaterThan(0)
    }
  })

  it('is disabled WITH A REASON the user can act on', () => {
    // One plain WHITE fill: no extrude for the first two, and no hue for the
    // third. Every preset must say something the user can act on.
    const bare = cfg({ appearance: [layer({ id: 'Lf', kind: 'fill' })] })
    for (const o of vtTrackPresetOffers(bare)) {
      // RUN-LEVEL presets need no layer at all, so a bare stack does not
      // disable them — they are the one kind this loop expects to stay on.
      if (o.preset.kind === 'run') { expect(o.available, o.preset.id).toBe(true); continue }
      expect(o.available, o.preset.id).toBe(false)
      // The reason names the preset's OWN kind, so a fill preset does not tell
      // the user to add an extrude.
      expect(o.reason, o.preset.id).toMatch(new RegExp(`${o.preset.kind} layer`))
      expect(o.layers, o.preset.id).toEqual([])
    }
    expect(vtTrackPresetOffer(vtTrackPreset('colour-cycle')!, bare).reason).toMatch(/saturation/)
    // An extrude that is THERE but inert gets its own sentence, because the fix
    // is different: raise the depth, do not add a layer.
    const inert = cfg({ appearance: [layer({ id: 'Le', kind: 'extrude', depth: 0 }), layer({ id: 'Lf', kind: 'fill' })] })
    expect(vtTrackPresetOffer(vtTrackPreset('extrude-sweep')!, inert).reason).toMatch(/depth of at least 1/)
    // A DISABLED extrude counts as absent — a track on it would be a dead row.
    const off = cfg({ appearance: [layer({ id: 'Le', kind: 'extrude', depth: 4, enabled: false })] })
    expect(vtTrackPresetOffer(vtTrackPreset('extrude-sweep')!, off).available).toBe(false)
  })

  it('replaces its own paths and leaves everything else the user authored', () => {
    const c0 = plentiful()
    const withUser = mergeConfig({
      ...c0,
      motion: { ...c0.motion, tracks: [track({ path: 'axes.wght', from: 100, to: 900 })] },
    })
    const once = vtApplyTrackPreset(withUser, 'extrude-sweep')
    const twice = vtApplyTrackPreset(
      mergeConfig({ ...withUser, motion: { ...withUser.motion, tracks: once } }),
      'extrude-sweep',
    )
    expect(twice).toEqual(once)
    expect(once.filter(t => t.path === 'axes.wght')).toHaveLength(1)
    expect(once.filter(t => t.path.endsWith('.angle'))).toHaveLength(2)
  })

  it('returns the SAME array when it cannot run', () => {
    const noExtrude = cfg({ appearance: [layer({ id: 'Lf', kind: 'fill' })] })
    expect(vtApplyTrackPreset(noExtrude, 'extrude-sweep')).toBe(noExtrude.motion.tracks)
    expect(vtApplyTrackPreset(noExtrude, 'not-a-preset')).toBe(noExtrude.motion.tracks)
  })

  it('reports itself active only while its own tracks are still what it wrote', () => {
    const c0 = plentiful()
    expect(vtTrackPresetActive(c0, 'extrude-sweep')).toBe(false)
    const on = mergeConfig({ ...c0, motion: { ...c0.motion, tracks: vtApplyTrackPreset(c0, 'extrude-sweep') } })
    expect(vtTrackPresetActive(on, 'extrude-sweep')).toBe(true)
    // The user drags the track: it is theirs now, and the tile stops claiming it.
    const edited = mergeConfig({
      ...on,
      motion: { ...on.motion, tracks: on.motion.tracks.map(t => ({ ...t, to: t.to / 2 })) },
    })
    expect(vtTrackPresetActive(edited, 'extrude-sweep')).toBe(false)
  })

  it('survives a raw stored blob with no motion block at all', () => {
    const raw = { appearance: [layer({ id: 'Le', kind: 'extrude', depth: 4 })] } as unknown as VectorTypeConfig
    expect(() => vtTrackPresetOffers(raw)).not.toThrow()
    expect(vtApplyTrackPreset(raw, 'extrude-sweep').map(t => t.path)).toEqual(['appearance.Le.angle'])
    // A missing config still has no addressable layers, so every LAYER-KIND
    // preset stays off — but a RUN-LEVEL one needs no layer, so it is on
    // regardless. That is the same rule as line ~369, restated for `null`.
    expect(vtTrackPresetOffers(null).every(o => o.preset.kind === 'run' ? o.available : !o.available)).toBe(true)
  })
})

/** A stack every preset accepts: two usable extrude plates and a coloured face. */
function plentiful(): VectorTypeConfig {
  return cfg({
    appearance: [
      layer({ id: 'Lc', kind: 'extrude', depth: 1, distance: 6, taper: 0, angle: 180, paint: paint('#00ffff') }),
      layer({ id: 'Lm', kind: 'extrude', depth: 1, distance: 6, taper: 0, angle: 0, paint: paint('#ff00ff') }),
      // SATURATED, so Colour Cycle accepts it too — a near-black face has no hue
      // to rotate and the preset would (correctly) refuse it.
      layer({ id: 'Lface', kind: 'fill', paint: paint('#cc2200') }),
    ],
    motion: { ...DEFAULT_CONFIG.motion, duration: 4, tracks: [] },
  })
}
