import { beforeEach, describe, expect, it, vi } from 'vitest'

// The font bridge's only side effect is fetching bytes through `loadVectorFont`.
// Mock it so the cache/subscribe/async-load logic is tested with no network and
// deterministic timing. `vi.hoisted` so the spy exists before `vi.mock`'s hoist.
const { loadVectorFont } = vi.hoisted(() => ({ loadVectorFont: vi.fn() }))
// `outline.ts` (used by runToCommands) also imports clampCoords/defaultCoords from
// this same module. The stub font below carries no axes, so both can be inert.
vi.mock('~/lib/vectortype/font', () => ({
  loadVectorFont,
  clampCoords: () => ({}),
  defaultCoords: () => ({}),
}))

import {
  __resetCompositorFontCacheForTest,
  compositorFontToken,
  getCompositorFont,
  onCompositorFontReady,
  runToCommands,
} from '~/lib/compositor/textOutline'
import type { VtFont } from '~/lib/vectortype/font'
import type { VectorCommand } from '~/lib/vector/svg'
import {
  outlinePathData,
  textLayerOutline,
  createTextLayer,
  createRectLayer,
  createEllipseLayer,
  createPathLayer,
} from '~/composables/useCompositorLayers'

const fakeFont = (id: string): VtFont => ({ id, axes: [], unitsPerEm: 1000, raw: {} })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetCompositorFontCacheForTest()
  loadVectorFont.mockReset()
})

describe('compositorFontToken', () => {
  it('resolves a curated variable family to its bare catalog id', () => {
    expect(compositorFontToken({ fontFamily: 'Inter', fontWeight: 700 })).toBe('inter')
    expect(compositorFontToken({ fontFamily: 'Roboto Flex', fontWeight: 400 })).toBe('roboto-flex')
  })

  it('resolves a library-manifest family to a local token', () => {
    expect(compositorFontToken({ fontFamily: 'OT 2049', fontWeight: 700 })).toBe('local:OT 2049@700')
  })

  it('falls back to a google token for an unknown, non-system family', () => {
    expect(compositorFontToken({ fontFamily: 'Roboto', fontWeight: 400 })).toBe('google:Roboto@400')
    expect(compositorFontToken({ fontFamily: 'Poppins', fontWeight: 600 })).toBe('google:Poppins@600')
  })

  it('returns null for system / generic families (no byte source)', () => {
    for (const f of ['Arial', 'Helvetica', 'sans-serif', 'serif', 'monospace', 'Times New Roman', 'Georgia'])
      expect(compositorFontToken({ fontFamily: f, fontWeight: 400 })).toBeNull()
  })

  it('is case-insensitive about system families and tolerant of whitespace', () => {
    expect(compositorFontToken({ fontFamily: '  arial ', fontWeight: 400 })).toBeNull()
    expect(compositorFontToken({ fontFamily: 'HELVETICA', fontWeight: 400 })).toBeNull()
  })

  it('returns null for an empty family and defaults a missing weight to 400', () => {
    expect(compositorFontToken({ fontFamily: '', fontWeight: 400 })).toBeNull()
    expect(compositorFontToken({ fontFamily: 'Roboto' })).toBe('google:Roboto@400')
  })
})

describe('getCompositorFont', () => {
  it('never fetches for a null-token family and returns null', () => {
    expect(getCompositorFont({ fontFamily: 'Arial', fontWeight: 400 })).toBeNull()
    expect(loadVectorFont).not.toHaveBeenCalled()
  })

  it('returns null on the first call, loads once, then serves the cached font and fires ready', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    const ready = vi.fn()
    onCompositorFontReady(ready)
    const layer = { fontFamily: 'Inter', fontWeight: 700 }

    expect(getCompositorFont(layer)).toBeNull()
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
    expect(loadVectorFont).toHaveBeenCalledWith('inter')
    expect(ready).not.toHaveBeenCalled()

    await flush()

    expect(ready).toHaveBeenCalledTimes(1)
    const f = getCompositorFont(layer)
    expect(f?.id).toBe('inter')
    // Cached: a second synchronous call is the same font, no new load.
    expect(getCompositorFont(layer)).toBe(f)
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight load between two layers of the same family', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 700 })
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 400 })
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('marks a failed load and returns null steadily without refetching or throwing', async () => {
    loadVectorFont.mockRejectedValue(new Error('HTTP 404'))
    const layer = { fontFamily: 'Not A Real Family', fontWeight: 400 }
    expect(() => getCompositorFont(layer)).not.toThrow()
    expect(getCompositorFont(layer)).toBeNull()
    await flush()
    expect(getCompositorFont(layer)).toBeNull()
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })
})

describe('onCompositorFontReady', () => {
  it('returns an unsubscribe that stops future notifications', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    const ready = vi.fn()
    const off = onCompositorFontReady(ready)
    off()
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 700 })
    await flush()
    expect(ready).not.toHaveBeenCalled()
  })
})

// ── runToCommands ────────────────────────────────────────────────────────────
//
// A fontkit STUB, not a real bundled font. The spec mocks `~/lib/vectortype/font`
// at file scope, so `loadVectorFont` can't hand back real bytes here; and a stub
// with KNOWN unitsPerEm/ascent/descent and two full-advance glyphs makes every
// placement assertion EXACT (no left-side-bearing slop), which the 0.5px
// tolerances would otherwise mask. runToCommands takes a `VtFont` directly and is
// pure, so no loader is involved. (See report: real-font parity is deferred to
// the caller's E2E in Task 3.)
//
// Each glyph is a 600×1000 box spanning the full advance (x 0→600) and the full
// ascent/descent (y −200→800, so it's vertically symmetric about the ascent/
// descent midline at font-y 300). advance 600, unitsPerEm 1000.
const stubGlyph = (ch: string) => ({
  id: ch.charCodeAt(0),
  advanceWidth: 600,
  codePoints: [ch.charCodeAt(0)],
  path: {
    commands: [
      { command: 'moveTo', args: [0, -200] },
      { command: 'lineTo', args: [600, -200] },
      { command: 'lineTo', args: [600, 800] },
      { command: 'lineTo', args: [0, 800] },
      { command: 'closePath', args: [] },
    ],
    bbox: { minX: 0, minY: -200, maxX: 600, maxY: 800 },
  },
})

const stubFont = (): VtFont => ({
  id: 'stub',
  axes: [],
  unitsPerEm: 1000,
  raw: {
    unitsPerEm: 1000,
    ascent: 800,
    descent: -200, // signed: below the baseline
    xHeight: 500,
    capHeight: 700,
    layout: (text: string) => {
      const glyphs = [...text].map(stubGlyph)
      return {
        glyphs,
        positions: glyphs.map((g) => ({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 })),
      }
    },
  },
})

// Bounds of a placed command list (even args = x, odd = y; closePath has none).
function bbox(cmds: VectorCommand[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of cmds) {
    for (let i = 0; i + 1 < c.args.length; i += 2) {
      const x = c.args[i]!, y = c.args[i + 1]!
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

describe('runToCommands', () => {
  const run = { text: 'AB', x: 50, y: 200 }
  // scale = fontPx / unitsPerEm = 100 / 1000 = 0.1
  const style = { fontPx: 100, letterSpacingPx: 0, align: 'left' as const, baseline: 'alphabetic' as const }
  const scale = 0.1
  const advanceSumPx = 2 * 600 * scale // 120

  it('left/alphabetic: first command starts at run.x and bbox width ≈ Σadvance×scale', () => {
    const cmds = runToCommands(stubFont(), run, style)
    expect(cmds[0]!.command).toBe('moveTo')
    expect(cmds[0]!.args[0]!).toBeCloseTo(run.x, 5) // exact, no left side bearing
    expect(bbox(cmds).w).toBeCloseTo(advanceSumPx, 5)
    expect(Math.abs(bbox(cmds).w - advanceSumPx)).toBeLessThanOrEqual(0.5)
  })

  it('center: the run bbox is centred on run.x', () => {
    const cmds = runToCommands(stubFont(), run, { ...style, align: 'center' })
    expect(bbox(cmds).cx).toBeCloseTo(run.x, 5)
    // left edge shifted by −width/2 from the left-aligned first command.
    expect(bbox(cmds).minX).toBeCloseTo(run.x - advanceSumPx / 2, 5)
  })

  it('right: the run bbox ends on run.x', () => {
    const cmds = runToCommands(stubFont(), run, { ...style, align: 'right' })
    expect(bbox(cmds).maxX).toBeCloseTo(run.x, 5)
  })

  it("middle: the bbox is vertically centred on run.y at the ascent/descent midline", () => {
    // Glyph box spans font-y −200→800 (midline 300); 'middle' anchors that
    // midline on run.y, so the placed bbox centre is run.y exactly.
    const cmds = runToCommands(stubFont(), run, { ...style, baseline: 'middle' })
    expect(bbox(cmds).cy).toBeCloseTo(run.y, 5)
    // ascent(800)+|descent|(200) = 1000 units → 100px tall, centred on run.y.
    expect(bbox(cmds).minY).toBeCloseTo(run.y - 50, 5)
    expect(bbox(cmds).maxY).toBeCloseTo(run.y + 50, 5)
  })

  it('alphabetic: the baseline (font-y 0) sits on run.y', () => {
    const cmds = runToCommands(stubFont(), run, style)
    // Box bottom at font-y −200 → run.y + 20; top at font-y 800 → run.y − 80.
    expect(bbox(cmds).maxY).toBeCloseTo(run.y + 20, 5)
    expect(bbox(cmds).minY).toBeCloseTo(run.y - 80, 5)
  })

  it('letterSpacing shifts the second glyph by exactly letterSpacingPx (px, not scaled)', () => {
    const ls = 10
    const noLs = runToCommands(stubFont(), run, style)
    const withLs = runToCommands(stubFont(), run, { ...style, letterSpacingPx: ls })
    // 5 commands per glyph → glyph 1's moveTo is index 5. Glyph 0 unchanged.
    expect(withLs[0]!.args[0]!).toBeCloseTo(noLs[0]!.args[0]!, 5)
    expect(withLs[5]!.command).toBe('moveTo')
    expect(withLs[5]!.args[0]! - noLs[5]!.args[0]!).toBeCloseTo(ls, 5)
  })

  it('is deterministic: same inputs → identical commands', () => {
    expect(runToCommands(stubFont(), run, style)).toEqual(runToCommands(stubFont(), run, style))
  })

  it('returns [] for an empty run', () => {
    expect(runToCommands(stubFont(), { text: '', x: 0, y: 0 }, style)).toEqual([])
  })
})

// ── textLayerOutline / outlinePathData (Task 3) ──────────────────────────────
//
// These reach into `useCompositorLayers`, which has no real 2D canvas in the node
// test env, so the layout/collect pass is driven over a minimal measuring ctx
// (measureText + the text-state props `applyFont` sets). The `~/lib/vectortype/font`
// mock at file scope means `getCompositorFont` loads the stub font, so a text layer
// on a resolvable family (Inter → 'inter') outlines and a system family (Arial) does
// not — the exact degrade F2 gates on.
function fakeMeasureCtx(): CanvasRenderingContext2D {
  return {
    font: '', textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px',
    fontVariationSettings: 'normal', lineJoin: 'miter', lineWidth: 1,
    measureText: (t: string) => ({ width: (t ? t.length : 0) * 10 }),
  } as unknown as CanvasRenderingContext2D
}

/** Prime the bridge cache so `getCompositorFont` returns the stub synchronously. */
async function primeInter() {
  loadVectorFont.mockResolvedValue(stubFont())
  // Kick the background load for the token 'inter', then let it settle.
  getCompositorFont({ fontFamily: 'Inter', fontWeight: 700 })
  await flush()
}

describe('textLayerOutline', () => {
  it('returns a non-empty d for a text layer on a resolvable (loaded) font', async () => {
    await primeInter()
    const layer = createTextLayer({ text: 'AB', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1 })
    const d = textLayerOutline(layer, 1000, fakeMeasureCtx())
    expect(d).toBeTruthy()
    expect(typeof d).toBe('string')
    // Real path data: at least one moveto and one closepath from the stub glyphs.
    expect(d).toMatch(/M/)
    expect(d).toMatch(/[Zz]/)
    expect((d as string).length).toBeGreaterThan(10)
  })

  it('returns null for a system-font layer (no byte source)', async () => {
    await primeInter() // font IS loaded, but Arial resolves to a null token
    const layer = createTextLayer({ text: 'AB', fontFamily: 'Arial', fontWeight: 400 })
    expect(textLayerOutline(layer, 1000, fakeMeasureCtx())).toBeNull()
  })

  it('returns null while the font is not yet loaded (kicks a background load)', () => {
    loadVectorFont.mockResolvedValue(stubFont())
    const layer = createTextLayer({ text: 'AB', fontFamily: 'Inter', fontWeight: 700 })
    // First call: font not in cache yet → null, and the caller degrades to fillText.
    expect(textLayerOutline(layer, 1000, fakeMeasureCtx())).toBeNull()
  })
})

describe('outlinePathData', () => {
  it('returns the text outline for a kind:text layer with a loaded font', async () => {
    await primeInter()
    const layer = createTextLayer({ text: 'AB', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1 })
    const d = outlinePathData(layer, 1000, fakeMeasureCtx())
    expect(d).toBeTruthy()
    expect(d).toBe(textLayerOutline(layer, 1000, fakeMeasureCtx()))
  })

  it('returns null for a kind:text layer on a system font', async () => {
    await primeInter()
    const layer = createTextLayer({ text: 'AB', fontFamily: 'Helvetica', fontWeight: 400 })
    expect(outlinePathData(layer, 1000, fakeMeasureCtx())).toBeNull()
  })

  it('leaves rect / ellipse / path outputs unchanged', () => {
    const rect = createRectLayer({ w: 0.3, h: 0.2, radius: 0 })
    const rd = outlinePathData(rect, 1000)
    expect(rd).toBeTruthy()
    expect(rd).toMatch(/^M/)

    const ell = createEllipseLayer({ w: 0.4, h: 0.2 })
    const ed = outlinePathData(ell, 1000)
    expect(ed).toBeTruthy()
    expect(ed).toMatch(/A/) // an ellipse path uses arc segments

    const path = createPathLayer({ d: 'M0 0 L10 0 L10 10 Z' })
    // A path layer returns its own stored `d`, verbatim and unaffected by W.
    expect(outlinePathData(path, 1000)).toBe('M0 0 L10 0 L10 10 Z')
    expect(outlinePathData(path, 7)).toBe('M0 0 L10 0 L10 10 Z')
  })

  it('returns null for a kind with no outline (line)', () => {
    // A line has no closed outline; unchanged from before this slice.
    expect(outlinePathData({ kind: 'line', w: 0.5, strokeWidth: 0.01 } as any, 1000)).toBeNull()
  })
})
