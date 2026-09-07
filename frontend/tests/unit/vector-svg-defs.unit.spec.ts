/**
 * The vector spine's `<defs>` — filters and clip-paths.
 *
 * Two halves, deliberately:
 *
 *  1. **The spine** (`~/lib/vector/svg`), driven with hand-built shapes. It is
 *     studio-agnostic — Shape Studio is its intended second consumer — so every
 *     assertion here is about SVG, not about type.
 *  2. **The adapter** (`~/lib/vectortype/render` + `vectorTypeSVG`), driven with
 *     real presets on the real fixture font, checking that what the canvas
 *     renderer does to the context is what the export writes to the file.
 *
 * The failure modes this is aimed at, none of which a screenshot can see:
 *
 *  - **One filter per glyph.** A 40-character word emitting 40 near-identical
 *    `<filter>` elements still LOOKS right; it is just a file no designer wants
 *    to open.
 *  - **Colliding ids.** Two exports pasted into one document, and one word's
 *    glyphs pick up the other word's blur.
 *  - **Unstable ids.** Re-exporting the same frame produces a different file
 *    every time, so the export cannot be diffed.
 *  - **A clip that travels with the glyph.** `clip-path` on the transformed
 *    `<path>` instead of on an untransformed wrapper turns a reveal into a
 *    permanently-masked letter being translated — plausible in every frame.
 *  - **A halved (or doubled) blur.** `stdDeviation` is not a `box-shadow`
 *    radius; getting it wrong is "almost right", which is the worst kind.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  blurRadiusToStdDeviation,
  defsIdPrefix,
  shapesToSVG,
  type VectorShape,
} from '~/lib/vector/svg'
import { glyphCellClipRect, glyphTransform as glyphPlacement } from '~/lib/vectortype/render'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, type VectorTypeConfig } from '~/lib/vectortype/config'
import { drawVectorType, vectorTypeSVG, vectorTypeFrame, vtPlacement } from '~/lib/vectortype/canvas'

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
const WORD = 'Sail'
const BOX = { width: 400, height: 200 }

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}

/**
 * A preset in one slot, easing replaced by `none` so progress is linear and
 * every expected number below is exact.
 *
 * `motion.in`/`motion.out` (the pre-Task-4 preset slots) are ONLY read by
 * `mergeConfig` when `motion.moves` is absent — see `hasNewShape`/`hasOldShape`
 * in `~/lib/vectortype/config`. `cfg()` already round-trips through
 * `mergeConfig`, so `c.motion` always carries a (possibly empty) `moves`
 * array, and spreading `{ ...c.motion, [slot]: {...} }` on top of that array
 * silently drops the slot — `hasNewShape` wins and the old-shape key is never
 * looked at. Since the 2026-09-04 moves redesign (181d8e11a, building on
 * fb08289e7) the one working way to add a preset to an already-merged config
 * is to push a `moves` entry, exactly as `vectortype-preset-motion.unit.spec.ts`
 * (`presetMove`) and `movesAdapter.ts` do.
 */
function withPreset(slot: 'in' | 'out', presetId: string, patch: Partial<VectorTypeConfig> = {}) {
  const c = cfg(patch)
  const duration = 1
  const placement = slot === 'in'
    ? { at: 0, loop: false }
    : { at: Math.max(0, c.motion.duration - duration), loop: false }
  return mergeConfig({
    ...c,
    motion: {
      ...c.motion,
      moves: [
        ...c.motion.moves,
        { id: `move-${slot}`, kind: 'preset', presetId, duration, ease: { kind: 'named', name: 'none' }, ...placement },
      ],
    },
  })
}

/** A square, as a command list — the spine's input, with no type anywhere. */
function square(x: number, y: number, s = 10): VectorShape['commands'] {
  return [
    { command: 'moveTo', args: [x, y] },
    { command: 'lineTo', args: [x + s, y] },
    { command: 'lineTo', args: [x + s, y + s] },
    { command: 'lineTo', args: [x, y + s] },
    { command: 'closePath', args: [] },
  ]
}

const DOC = { width: 200, height: 100, viewBox: [0, 0, 200, 100] as [number, number, number, number] }

const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length
const FILTERS = /<filter\b/g
const CLIPPATHS = /<clipPath\b/g
const idsIn = (svg: string) => (svg.match(/\bid="([^"]+)"/g) ?? []).map(s => s.slice(4, -1))

// ── the spine ───────────────────────────────────────────────────────────────

describe('<defs> — the spine emits none until something needs one', () => {
  it('writes no <defs> at all for plain shapes', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), fill: '#fff' }], DOC)
    expect(svg).not.toContain('<defs>')
    expect(svg).not.toContain('<filter')
    expect(svg).not.toContain('<clipPath')
    // and no wrapper <g> either: an unaffected shape is still a bare <path>.
    expect(svg).toContain('<g><path')
  })

  it('puts <defs> BEFORE the drawing group — a forward reference is not a file', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 4 }], DOC)
    expect(svg.indexOf('<defs>')).toBeGreaterThan(-1)
    expect(svg.indexOf('<defs>')).toBeLessThan(svg.indexOf('<g><'))
    expect(svg.indexOf('</defs>')).toBeLessThan(svg.indexOf('<path'))
  })
})

describe('<filter> — one per DISTINCT blur, not one per shape', () => {
  it('collapses 40 shapes at two radii into two filters', () => {
    const shapes: VectorShape[] = []
    for (let i = 0; i < 40; i++) shapes.push({ commands: square(i * 4, 10), blur: i % 2 ? 3 : 7 })
    const svg = shapesToSVG(shapes, DOC)
    expect(count(svg, FILTERS)).toBe(2)
    // …and all 40 shapes are still wrapped and still referencing one of them.
    expect(count(svg, /filter="url\(#/g)).toBe(40)
    const ids = idsIn(svg)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(svg).toContain(`filter="url(#${id})"`)
  })

  it('deduplicates on the SERIALISED value, so 3 and 3.0000001 share a filter', () => {
    const svg = shapesToSVG([
      { commands: square(10, 10), blur: 3 },
      { commands: square(30, 10), blur: 3.0000001 },
      { commands: square(50, 10), blur: 3.4 },
    ], DOC)
    // Two shapes round to "3" at precision 3; the third does not.
    expect(count(svg, FILTERS)).toBe(2)
  })

  it('writes stdDeviation as the blur itself — no factor of two', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 12 }], DOC)
    expect(svg).toContain('<feGaussianBlur stdDeviation="12"/>')
    expect(svg).not.toContain('stdDeviation="6"')
    expect(svg).not.toContain('stdDeviation="24"')
  })

  it('gives the filter a userSpaceOnUse region covering the document plus 3σ', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 12 }], DOC)
    expect(svg).toContain('filterUnits="userSpaceOnUse"')
    // viewBox 0 0 200 100, σ 12 → pad 36 → -36 -36 272 172. The DEFAULT region
    // is -10%..120% of the object bbox, which for a tall narrow shape is far
    // smaller than the blur and visibly crops it (measured: 1920 ink px against
    // the canvas's 11246).
    expect(svg).toContain('x="-36" y="-36" width="272" height="172"')
  })

  it('asks for sRGB interpolation — SVG defaults to linearRGB, canvas does not', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 4 }], DOC)
    expect(svg).toContain('color-interpolation-filters="sRGB"')
  })

  it('emits nothing for a blur too small to see', () => {
    const svg = shapesToSVG([
      { commands: square(10, 10), blur: 0 },
      { commands: square(30, 10), blur: 0.001 },
      { commands: square(50, 10), blur: Number.NaN as number },
    ], DOC)
    expect(svg).not.toContain('<filter')
    expect(svg).not.toContain('<g><g')
  })
})

describe('<clipPath> — one per DISTINCT rect', () => {
  it('collapses repeats and keeps genuinely different windows apart', () => {
    const a = { x: 0, y: 0, width: 50, height: 50 }
    const b = { x: 0, y: 10, width: 50, height: 40 }
    const svg = shapesToSVG([
      { commands: square(10, 10), clip: a },
      { commands: square(30, 10), clip: { ...a } },
      { commands: square(50, 10), clip: b },
    ], DOC)
    expect(count(svg, CLIPPATHS)).toBe(2)
    expect(count(svg, /clip-path="url\(#/g)).toBe(3)
    expect(svg).toContain('clipPathUnits="userSpaceOnUse"')
    expect(svg).toContain('<rect x="0" y="0" width="50" height="50"/>')
    expect(svg).toContain('<rect x="0" y="10" width="50" height="40"/>')
  })

  it('rides on an UNTRANSFORMED wrapper, never on the transformed path', () => {
    const svg = shapesToSVG([{
      commands: square(10, 10),
      clip: { x: 0, y: 0, width: 50, height: 50 },
      attrs: { transform: 'translate(0 30)' },
    }], DOC)
    // The wrapper carries the clip and NO transform; the path carries the
    // transform and NO clip. Swap them and the window travels with the shape —
    // a reveal becomes a masked shape sliding across the frame.
    expect(svg).toMatch(/<g clip-path="url\(#[^"]+\)"><path\b/)
    expect(svg).not.toMatch(/<g[^>]*clip-path[^>]*transform/)
    expect(svg).not.toMatch(/<path[^>]*clip-path/)
    expect(svg).toMatch(/<path[^>]*transform="translate\(0 30\)"/)
  })

  it('keeps a zero-extent window as zero — an amount-1 mask shows nothing', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), clip: { x: 5, y: 5, width: 40, height: 0 } }], DOC)
    expect(svg).toContain('height="0"')
  })
})

describe('filter and clip together', () => {
  it('shares ONE wrapper, filter first — the order ctx.filter/ctx.clip/fill gives', () => {
    const svg = shapesToSVG([{
      commands: square(10, 10),
      blur: 4,
      clip: { x: 0, y: 0, width: 50, height: 50 },
    }], DOC)
    // SVG applies an element's filter, then clips the RESULT — the same order a
    // canvas produces when the filter is set and the clip taken before the fill.
    expect(svg).toMatch(/<g filter="url\(#[^"]+\)" clip-path="url\(#[^"]+\)"><path/)
    expect(count(svg, /<g /g)).toBe(1)
    expect(count(svg, FILTERS)).toBe(1)
    expect(count(svg, CLIPPATHS)).toBe(1)
  })
})

describe('ids — stable, and unique across documents', () => {
  const doc = (blur: number, x: number) =>
    shapesToSVG([{ commands: square(x, 10), blur }], DOC)

  it('are byte-identical when the same document is exported twice', () => {
    expect(doc(4, 10)).toBe(doc(4, 10))
  })

  it('differ when ANY of the geometry or the defs differ', () => {
    const sameDefsDifferentInk = new Set([idsIn(doc(4, 10))[0], idsIn(doc(4, 40))[0]])
    expect(sameDefsDifferentInk.size).toBe(2)
    const differentDefs = new Set([idsIn(doc(4, 10))[0], idsIn(doc(9, 10))[0]])
    expect(differentDefs.size).toBe(2)
  })

  it('do not collide when two exports are pasted into one file', () => {
    const a = idsIn(doc(4, 10))
    const b = idsIn(doc(9, 40))
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(a.filter(id => b.includes(id))).toEqual([])
  })

  it('honour an explicit prefix, for a caller stitching documents together', () => {
    const svg = shapesToSVG([{ commands: square(10, 10), blur: 4, clip: { x: 0, y: 0, width: 5, height: 5 } }], {
      ...DOC,
      idPrefix: 'mine',
    })
    expect(svg).toContain('id="mine-b0"')
    expect(svg).toContain('id="mine-c0"')
    expect(svg).toContain('filter="url(#mine-b0)"')
    expect(svg).toContain('clip-path="url(#mine-c0)"')
  })

  it('are a pure function of the content string', () => {
    expect(defsIdPrefix('abc')).toBe(defsIdPrefix('abc'))
    expect(defsIdPrefix('abc')).not.toBe(defsIdPrefix('abd'))
    expect(defsIdPrefix('abc')).toMatch(/^s[0-9a-z]{7}$/)
  })
})

describe('blurRadiusToStdDeviation', () => {
  it('is the identity — CSS blur(N) IS feGaussianBlur stdDeviation N', () => {
    // Measured in Chrome: a rect under ctx.filter='blur(12px)' and the same rect
    // under stdDeviation="12" give a bit-identical alpha profile (RMS 0.000);
    // σ = 6 gives RMS 15.5. The halving belongs to box-shadow, not to this.
    expect(blurRadiusToStdDeviation(12)).toBe(12)
    expect(blurRadiusToStdDeviation(0.5)).toBe(0.5)
  })

  it('floors at zero rather than emitting a negative or a NaN', () => {
    expect(blurRadiusToStdDeviation(0)).toBe(0)
    expect(blurRadiusToStdDeviation(-3)).toBe(0)
    expect(blurRadiusToStdDeviation(Number.NaN)).toBe(0)
    expect(blurRadiusToStdDeviation(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

// ── the adapter: the export must match what the canvas drew ─────────────────

class FakePath2D {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
}
let hadPath2D: unknown
beforeAll(() => {
  hadPath2D = (globalThis as any).Path2D
  ;(globalThis as any).Path2D = FakePath2D
})
afterAll(() => { (globalThis as any).Path2D = hadPath2D })

/** Just enough context to record the two things this spec compares against the
 *  file: the blur radii set, and the rects clipped. */
class RecCtx {
  filters: string[] = []
  rects: Array<{ x: number; y: number; w: number; h: number }> = []
  filter = 'none'
  globalAlpha = 1
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 0
  lineJoin = ''
  save() {}
  restore() { this.filter = 'none' }
  setTransform() {}
  clearRect() {}
  fillRect() {}
  translate() {}
  rotate() {}
  scale() {}
  beginPath() {}
  rect(x: number, y: number, w: number, h: number) { this.rects.push({ x, y, w, h }) }
  clip() {}
  fill() { if (this.filter !== 'none') this.filters.push(this.filter) }
  stroke() {}
}

function canvasOps(c: VectorTypeConfig, t: number) {
  const ctx = new RecCtx()
  drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, BOX)
  return ctx
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

describe('vectorTypeSVG — blur exports as a filter the canvas agrees with', () => {
  it('emits ONE filter for a whole word at one radius, referenced by every glyph', () => {
    const c = withPreset('in', 'blur-in')
    const { svg, frame } = vectorTypeSVG(font, c, 0.5, BOX)
    expect(frame.outlines.glyphs.length).toBe(WORD.length)
    expect(count(svg, FILTERS)).toBe(1)
    expect(count(svg, /filter="url\(#/g)).toBe(WORD.length)
    // blur-in at linear progress 0.5 → 0.12 × 0.5 × em(100) = 6px.
    expect(svg).toContain('<feGaussianBlur stdDeviation="6"/>')
  })

  it('writes the SAME number the canvas blurs by, at pixelRatio 1', () => {
    const c = withPreset('in', 'blur-in')
    const ctx = canvasOps(c, 0.5)
    expect(new Set(ctx.filters)).toEqual(new Set(['blur(6px)']))
    const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
    const sd = /stdDeviation="([\d.]+)"/.exec(svg)?.[1]
    expect(sd).toBe('6')
  })

  it('does NOT follow the canvas into device pixels — an SVG has no pixelRatio', () => {
    // The canvas multiplies its radius by pixelRatio because ITS blur is in
    // device px and ignores the CTM. The SVG's user units ARE the output px, so
    // the same config exports the same stdDeviation whatever the preview scale.
    const c = withPreset('in', 'blur-in')
    const ctxA = canvasOps(c, 0.5)
    const ctx2 = new RecCtx()
    drawVectorType(ctx2 as unknown as CanvasRenderingContext2D, font, c, 0.5, { ...BOX, pixelRatio: 2 })
    expect(ctxA.filters[0]).toBe('blur(6px)')
    expect(ctx2.filters[0]).toBe('blur(12px)')
    expect(vectorTypeSVG(font, c, 0.5, BOX).svg).toContain('stdDeviation="6"')
  })

  it('writes no filter at all once the entrance has finished', () => {
    const { svg } = vectorTypeSVG(font, withPreset('in', 'blur-in'), 1.5, BOX)
    expect(svg).not.toContain('<filter')
    expect(svg).not.toContain('<defs>')
  })

  it('keeps ONE filter per distinct radius under a stagger, not one per glyph', () => {
    const c = withPreset('in', 'blur-in')
    const staggered = mergeConfig({
      ...c,
      motion: { ...c.motion, stagger: { delay: 0.15, order: 'forward' } },
    })
    const { svg } = vectorTypeSVG(font, staggered, 0.5, BOX)
    const filters = count(svg, FILTERS)
    // Each glyph is at its own progress, so several radii are legitimate — but
    // never MORE than one per glyph, and the references still all resolve.
    expect(filters).toBeGreaterThan(1)
    expect(filters).toBeLessThanOrEqual(WORD.length)
    const ids = new Set(idsIn(svg))
    for (const ref of svg.match(/filter="url\(#([^)]+)\)"/g) ?? []) {
      expect(ids.has(ref.slice(13, -2))).toBe(true)
    }
  })
})

describe('vectorTypeSVG — the mask window is the canvas window', () => {
  it('clips at EXACTLY the rect the canvas clips at', () => {
    const c = withPreset('in', 'mask-up')
    const ctx = canvasOps(c, 0.4)
    expect(ctx.rects.length).toBe(WORD.length)
    const { svg } = vectorTypeSVG(font, c, 0.4, BOX)
    const rects = [...svg.matchAll(/<clipPath[^>]*><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"\/>/g)]
      .map(m => ({ x: +(m[1] as string), y: +(m[2] as string), w: +(m[3] as string), h: +(m[4] as string) }))
    expect(rects.length).toBeGreaterThan(0)
    // Every window the canvas took must exist in the file, to 3 decimals.
    for (const r of ctx.rects) {
      expect(rects).toContainEqual({ x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h) })
    }
  })

  it('is the shared glyphCellClipRect, not a second derivation', () => {
    const c = withPreset('in', 'mask-up')
    const frame = vectorTypeFrame(font, c, 0.4)
    const place = vtPlacement(frame, BOX)
    const em = place.scale * (frame.outlines.unitsPerEm || 1000)
    const ctx = canvasOps(c, 0.4)
    frame.outlines.glyphs.forEach((g, i) => {
      const clip = frame.transforms[i]?.clip
      if (!clip) return
      const want = glyphCellClipRect(glyphPlacement(g, place), g.advance * place.scale, em, clip)
      const got = ctx.rects[i]
      expect(got?.x).toBeCloseTo(want.x, 6)
      expect(got?.y).toBeCloseTo(want.y, 6)
      expect(got?.w).toBeCloseTo(want.width, 6)
      expect(got?.h).toBeCloseTo(want.height, 6)
    })
  })

  it('leaves the window STILL while the glyph transform moves — the reveal', () => {
    // mask-up gives each glyph both a dy and a clip. If the clip rode on the
    // transformed <path>, the two would move together and the reveal would be
    // gone. The wrapper is what keeps them apart, so assert the shape of the
    // markup as well as the numbers.
    const c = withPreset('in', 'mask-up')
    const { svg } = vectorTypeSVG(font, c, 0.4, BOX)
    expect(svg).toMatch(/<g clip-path="url\(#[^"]+\)"><path[^>]*transform="translate\(/)
    expect(svg).not.toMatch(/<path[^>]*clip-path/)
    // …and the window's fixed edge does not move between two times, while the
    // glyph's transform does.
    const at = (t: number) => {
      const s = vectorTypeSVG(font, c, t, BOX).svg
      return {
        clipY: +((/<clipPath[^>]*><rect x="[-\d.]+" y="([-\d.]+)"/.exec(s) ?? [])[1] as string),
        clipH: +((/<clipPath[^>]*><rect x="[-\d.]+" y="[-\d.]+" width="[-\d.]+" height="([-\d.]+)"/.exec(s) ?? [])[1] as string),
        dy: +((/transform="translate\([-\d.]+ ([-\d.]+)\)/.exec(s) ?? [])[1] as string),
      }
    }
    const a = at(0.2)
    const b = at(0.6)
    // The window's BOTTOM edge (y + height) is what mask-up holds still.
    expect(a.clipY + a.clipH).toBeCloseTo(b.clipY + b.clipH, 6)
    expect(a.clipH).not.toBeCloseTo(b.clipH, 3)
    expect(a.dy).not.toBeCloseTo(b.dy, 3)
  })
})

describe('the export stays REAL vector', () => {
  it('carries no raster of any kind, with blur and mask both live', () => {
    for (const t of [0.2, 0.5, 0.9]) {
      for (const id of ['blur-in', 'mask-up', 'blur-slide-up']) {
        const { svg } = vectorTypeSVG(font, withPreset('in', id), t, BOX)
        expect(svg).not.toContain('<image')
        expect(svg).not.toContain('base64')
        expect(svg).not.toContain('data:image')
        expect(svg).not.toContain('xlink:href')
        expect(svg).not.toContain('<feImage')
        // still real outlines under the wrappers
        expect(svg).toMatch(/<path d="M[^"]*[QC]/)
      }
    }
  })
})
