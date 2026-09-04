/**
 * `exportTier` — the studio's central claim, stated per fill type.
 *
 * Vector Type's whole pitch is that its SVG is real, editable vector: "no
 * raster, no `<image>`, nothing traced". Six of the eleven fill types keep that
 * promise. `ombre`, `noise`, `shader`, `shapes` and `paper` cannot — a
 * per-pixel hash, a fragment program, an arbitrary silhouette, and a grain
 * texture all have no geometry `patternFor` can recover — so the export embeds
 * a picture. All eleven shipped knowing that, on the condition that the
 * product says which is which.
 *
 * The failure mode this file exists to prevent is NOT "the tier is wrong
 * today". It is **a tier table that drifts away from the emitters** and goes on
 * confidently stating a falsehood — telling a user their grid fill is real
 * vector after someone moved it onto the raster bridge, or (worse) leaving the
 * note off a kind that quietly stopped being vectorisable. A table that lies is
 * worse than no table at all, because the note is the only thing standing
 * between the user and a surprise in Illustrator.
 *
 * So there are two halves:
 *
 *  1. **Exhaustive and derived.** Every member of `FILL_TYPES` gets a tier, the
 *     tier is a function of the KIND rather than of the box it was asked with,
 *     and nothing about it is a hand-written list of names.
 *  2. **Checked against the real document.** For each of the eleven, a real SVG
 *     comes out of `vectorTypeSVG` — the same function the Export SVG button
 *     calls — and its `<defs>` are classified independently. The tier must
 *     agree with what is actually in the file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { exportTier, paintIsVector, paintToVectorPaint, type ExportTier } from '~/lib/paint/toVector'
import { isVectorGradient, isVectorPattern } from '~/lib/vector/svg'
import { DEFAULT_FILL, FILL_TYPES, type Fill, type FillType } from '~/lib/spacetype/fillTile'
import type { Gradient } from '~/lib/compositor/paint'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, vtLayer, type VectorTypeConfig } from '~/lib/vectortype/config'
import { vectorTypeSVG } from '~/lib/vectortype/canvas'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()

function fill(type: FillType, patch: Partial<Fill> = {}): Fill {
  return { ...DEFAULT_FILL, type, a: '#ffe600', b: '#111111', angle: 35, density: 8, ...patch }
}

/**
 * THE TABLE. Written out here, in full, as the contract — and then checked
 * against the emitters below rather than trusted. Six vector, three raster.
 */
const TIERS: Record<FillType, ExportTier> = {
  solid: 'vector',
  gradient: 'vector',
  grid: 'pattern',
  checkerboard: 'pattern',
  stripes: 'pattern',
  qr: 'pattern',
  ombre: 'raster',
  noise: 'raster',
  shader: 'raster',
  // `shapes` has no cell structure of its own — it falls through `patternFor`
  // to the same `rasterTile` fallback `noise` does, so it earns the same tier.
  shapes: 'raster',
  // `paper` has no geometric vector form either — it is a per-pixel grain
  // texture, not a cell pattern — so it falls through the same `patternFor` →
  // `rasterTile` path and earns the same tier.
  paper: 'raster',
}

// ── half one: exhaustive, and about the kind ────────────────────────────────

describe('exportTier — every one of the eleven fill types has a tier', () => {
  it('covers the catalog exactly — no kind unlisted, no kind invented', () => {
    // Both directions. An eleventh fill type added to `FILL_TYPES` without a
    // tier fails the first; a tier for a kind that no longer exists fails the
    // second.
    expect([...FILL_TYPES].sort()).toEqual(Object.keys(TIERS).sort())
    expect(FILL_TYPES).toHaveLength(11)
  })

  it('answers with a real tier for every one of them — nothing falls through', () => {
    for (const type of FILL_TYPES) {
      const tier = exportTier(fill(type))
      expect(['vector', 'pattern', 'raster']).toContain(tier)
      expect(tier).toBe(TIERS[type])
    }
  })

  it('splits six real-vector kinds from five raster ones — the number to watch', () => {
    const byTier = FILL_TYPES.reduce<Record<string, FillType[]>>((acc, t) => {
      (acc[exportTier(fill(t))] ||= []).push(t)
      return acc
    }, {})
    expect(byTier.raster).toEqual(['ombre', 'noise', 'shader', 'shapes', 'paper'])
    expect([...(byTier.vector ?? []), ...(byTier.pattern ?? [])]).toHaveLength(6)
  })

  it('is a question about the KIND, not about the box it was asked with', () => {
    // The tier drives a sentence in the inspector, which is shown before any
    // glyph box exists. A pattern refuses to emit without a box to anchor to,
    // so a naive `paintToVectorPaint(paint, {}) === null` test would report the
    // four pattern kinds as raster and put the note on seven kinds instead of
    // three. The helper supplies its own unit box for exactly that reason —
    // and the answer must not move when a caller has a real box.
    for (const type of FILL_TYPES) {
      const tier = exportTier(fill(type))
      for (const box of [{ x: 0, y: 0, width: 1, height: 1 }, { x: 40, y: -12, width: 813.5, height: 199 }]) {
        const vp = paintToVectorPaint(fill(type), { units: 'userSpaceOnUse', box })
        const observed: ExportTier = isVectorPattern(vp) ? 'pattern' : vp === null ? 'raster' : 'vector'
        expect(observed).toBe(tier)
      }
    }
  })

  it('does not move with a kind\'s own parameters — colour, angle, density', () => {
    for (const type of FILL_TYPES) {
      for (const patch of [{ angle: 0 }, { angle: 137 }, { density: 2 }, { density: 32 }, { a: '#000', b: '#000' }]) {
        expect(exportTier(fill(type, patch))).toBe(TIERS[type])
      }
    }
  })

  it('reads a bare colour string and a multi-stop Gradient as vector too', () => {
    // `Paint` is wider than `Fill`: legacy configs hold a string, and the
    // multi-stop / radial forms live only on `Gradient`. All three are paint
    // servers, so none of them earns the note.
    expect(exportTier('#ff8800')).toBe('vector')
    const linear: Gradient = { type: 'linear', angle: 20, stops: [
      { offset: 0, color: '#f00' }, { offset: 0.5, color: '#0f0' }, { offset: 1, color: '#00f' },
    ] }
    expect(exportTier(linear)).toBe('vector')
    expect(exportTier({ type: 'radial', stops: linear.stops })).toBe('vector')
  })

  it('still says raster when the export wraps the picture in a `<pattern>`', () => {
    // THE TRAP. The tier 3 arm embeds the pixels as `<pattern><image
    // href="data:…">`, so the exported document DOES contain a `<pattern>` for a
    // shader fill — and a tier read as "did a pattern come back?" would flip
    // those five to `pattern`, drop the note, and leave the studio silently
    // claiming editable vector for the only five fills that are not. The
    // tile's CONTENT is what decides, never the element name.
    const RASTER = 'data:image/png;base64,iVBORw0KGgo='
    const box = { x: 0, y: 0, width: 240, height: 120 }
    const withRaster = (type: FillType) =>
      paintToVectorPaint(fill(type), { units: 'userSpaceOnUse', box, raster: RASTER } as any) as any

    for (const type of ['ombre', 'noise', 'shader', 'shapes', 'paper'] as FillType[]) {
      // Written so it does not depend on WHICH tree it runs in: offered pixels,
      // these five either come back as a picture in a pattern wrapper or do not
      // come back at all. Neither is editable vector, and the tier says so
      // either way — that last line is the load-bearing one.
      const vp = withRaster(type)
      const embedded = isVectorPattern(vp) && vp.image === RASTER && vp.rects.length === 0
      expect(vp === null || embedded, `${type} answered a raster request with real geometry`).toBe(true)
      expect(exportTier(fill(type))).toBe('raster')
    }
    // …and the four real pattern kinds IGNORE a raster they were handed: they
    // have geometry of their own, so they must never fall back to a picture.
    for (const type of ['grid', 'checkerboard', 'stripes', 'qr'] as FillType[]) {
      const vp = withRaster(type)
      expect(isVectorPattern(vp)).toBe(true)
      expect(vp.image, `${type} embedded a raster it did not need`).toBeUndefined()
      expect(vp.rects.length, `${type} emitted an empty tile`).toBeGreaterThan(0)
      expect(exportTier(fill(type))).toBe('pattern')
    }
  })

  it('calls a paint with no vector form at all raster, rather than guessing', () => {
    // Not a fill type — no kind to name — but the honest answer to "will this
    // come out as editable geometry?" is still no. The surface guards on
    // `isFill` before naming anything, so this never produces a sentence about
    // an "undefined fill".
    expect(exportTier(undefined)).toBe('raster')
    expect(exportTier({ type: 'linear', angle: 0, stops: [] })).toBe('raster')
  })

  it('keeps paintIsVector as exactly "not raster" — both vector tiers count', () => {
    for (const type of FILL_TYPES) {
      expect(paintIsVector(fill(type))).toBe(exportTier(fill(type)) !== 'raster')
    }
    // …and a `<pattern>` of real rects is genuine vector, not a middle state
    // that the claim has to be softened for.
    expect(paintIsVector(fill('checkerboard'))).toBe(true)
  })
})

// ── half two: the tier vs. the document the exporter really writes ──────────

/**
 * What is actually in an exported file, read back from the text rather than
 * from anything the tier helper believes.
 */
function exportFacts(svg: string) {
  const defs = /<defs>([\s\S]*)<\/defs>/.exec(svg)?.[1] ?? ''
  return {
    /** A real paint server a designer can add a stop to. */
    gradientDef: /<(?:linear|radial)Gradient\b/.test(defs),
    /** A real tile of rectangles a designer can select and recolour. */
    patternDef: /<pattern\b/.test(defs),
    /** ANY embedded bitmap, however it is spelled. */
    raster: /<image\b|data:image|xlink:href|<feImage\b/.test(svg),
    /** The glyph paths reference a paint server rather than carrying a colour. */
    urlRef: /fill="url\(#/.test(svg),
  }
}


/** ═══ APPEARANCE STACK ═══ the `fill` / `fillAnchor` a caller asks for is now
 *  the BASE FILL LAYER's paint and anchor. Translated here so every call site
 *  below reads as it did — the stack is what changed, not what these tests
 *  assert about the document. */
function vtStack(fill: unknown, fillAnchor: unknown) {
  return [vtLayer({ id: 'Lfill', paint: fill as any, anchor: (fillAnchor ?? 'glyph') as any })]
}

function exportOf(type: FillType, patch: Partial<VectorTypeConfig> & Record<string, unknown> = {}): string {
  const { fill: paint, fillAnchor, ...rest } = patch as Record<string, unknown>
  const cfg = mergeConfig({
    ...DEFAULT_CONFIG, text: 'Sail', size: 100,
    appearance: vtStack(paint ?? fill(type), fillAnchor), ...rest,
  })
  // No background — a background rect would put a second `fill="#…"` in the
  // document and blur the reading of what the GLYPHS are painted with.
  return vectorTypeSVG(font, cfg, 0, { width: 800, height: 300, background: null }).svg
}

describe('the tier matches the document vectorTypeSVG actually writes', () => {
  it('gives every vector-tier kind a real paint server, and no raster anywhere', () => {
    for (const type of FILL_TYPES) {
      if (exportTier(fill(type)) !== 'vector') continue
      const f = exportFacts(exportOf(type))
      expect(f.raster, `${type} exported a raster while claiming vector`).toBe(false)
      expect(f.patternDef, `${type} exported a pattern while claiming a gradient/flat`).toBe(false)
      // `solid` is a literal colour on the path — the simplest real vector
      // there is — and `gradient` is a paint server. Both are tier `vector`;
      // what unites them is that neither is a picture.
      expect(type === 'solid' ? !f.gradientDef && !f.urlRef : f.gradientDef && f.urlRef).toBe(true)
    }
  })

  it('gives every pattern-tier kind real `<pattern>` geometry, and no raster', () => {
    for (const type of FILL_TYPES) {
      if (exportTier(fill(type)) !== 'pattern') continue
      const f = exportFacts(exportOf(type))
      expect(f.patternDef, `${type} claims a pattern but wrote none`).toBe(true)
      expect(f.urlRef).toBe(true)
      expect(f.raster, `${type} exported a raster while claiming a pattern`).toBe(false)
      // Rectangles, not a picture inside a tile.
      expect(/<pattern\b[^>]*>[\s\S]*?<rect\b/.test(exportOf(type))).toBe(true)
    }
  })

  it('never lets a raster-tier kind pass itself off as editable geometry', () => {
    // Deliberately written to hold BOTH before and after the raster embed
    // lands: today these degrade to a flat representative colour, and once
    // `<pattern><image href="data:…">` ships they will carry a picture. What
    // must never be true either way is that one of them wrote a gradient, or a
    // `<pattern>` of real rects, i.e. quietly became vector without the tier
    // being told.
    for (const type of FILL_TYPES) {
      if (exportTier(fill(type)) !== 'raster') continue
      const svg = exportOf(type)
      const f = exportFacts(svg)
      expect(f.gradientDef, `${type} wrote a gradient but is tiered raster`).toBe(false)
      if (f.patternDef) {
        // A pattern from a raster-tier kind is only legitimate as the wrapper
        // around an embedded image.
        expect(f.raster, `${type} wrote real pattern geometry but is tiered raster`).toBe(true)
      }
    }
  })

  it('holds on all three fill anchors — the tier is not an artefact of one', () => {
    for (const anchor of ['glyph', 'word', 'frame'] as const) {
      for (const type of FILL_TYPES) {
        const f = exportFacts(exportOf(type, { fillAnchor: anchor } as Partial<VectorTypeConfig>))
        if (exportTier(fill(type)) === 'raster') continue
        expect(f.raster, `${type} @ ${anchor} embedded a raster`).toBe(false)
      }
    }
  })

  it('detects the drift it is aimed at — a mis-tiered kind fails', () => {
    // The control. If the assertions above could not tell a vector kind from a
    // raster one, they would pass for any table at all. Swap two entries and
    // the document check must reject them.
    const grid = exportFacts(exportOf('grid'))
    const noise = exportFacts(exportOf('noise'))
    expect(grid.patternDef).toBe(true)
    expect(noise.patternDef && !noise.raster).toBe(false)
    // …and the two documents are genuinely different files, not the same
    // fallback twice.
    expect(exportOf('grid')).not.toBe(exportOf('noise'))
  })
})

// ── the sentence the surface builds from this ───────────────────────────────

describe('the copy the studio derives from the tier', () => {
  it('names exactly the six kinds that export as real vector', () => {
    // `VectorTypeSurface` builds "Solid, gradient, grid, checkerboard, stripes
    // and qr export as real vector" from this filter rather than from a typed
    // sentence, so the prose cannot outlive the fact.
    expect(FILL_TYPES.filter(t => paintIsVector({ ...DEFAULT_FILL, type: t })))
      .toEqual(['solid', 'gradient', 'grid', 'checkerboard', 'stripes', 'qr'])
  })

  it('names exactly the five that do not', () => {
    expect(FILL_TYPES.filter(t => !paintIsVector({ ...DEFAULT_FILL, type: t })))
      .toEqual(['ombre', 'noise', 'shader', 'shapes', 'paper'])
  })
})
