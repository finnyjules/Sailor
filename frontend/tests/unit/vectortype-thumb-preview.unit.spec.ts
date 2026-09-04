/**
 * Vector Type — the preset TILE's pure half (`~/lib/vectortype/thumbPreview`).
 *
 * `VectorTypeThumb.vue` is a canvas and a clock registration around these three
 * functions, so the decisions that actually go wrong in a thumbnail — which word
 * it shows, how much of a long word survives, and whether the biggest frame of
 * the animation still fits the tile — are pinned here rather than eyeballed.
 *
 * NO NETWORK: the same eight-character Inter variable subset (" Sailorg",
 * opsz + wght, 2048 upem) the outline and canvas specs use.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_FILL } from '~/lib/spacetype/fillTile'
import { mergeConfig, vtBaseAppearance } from '~/lib/vectortype/config'
import { vectorTypeFrame, vtIsAnimated, vtPlacement } from '~/lib/vectortype/canvas'
import { vtHasPreset } from '~/lib/vectortype/presetMotion'
import {
  VT_THUMB_CYCLE,
  VT_THUMB_FALLBACK,
  VT_THUMB_H,
  VT_THUMB_MAX_GLYPHS,
  VT_THUMB_PAD,
  VT_THUMB_PHASE,
  VT_THUMB_W,
  vtThumbConfig,
  vtThumbSize,
  vtThumbWord,
} from '~/lib/vectortype/thumbPreview'

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
const BOX = { width: VT_THUMB_W, height: VT_THUMB_H, padding: VT_THUMB_PAD }

/** The ink the tile would actually paint, in tile pixels, at time `t`. Placed
 *  exactly as `drawVectorType` places it (same `vtPlacement`), so "fits the
 *  box" here means what it means on screen. */
function inkBox(cfg: ReturnType<typeof vtThumbConfig>, t: number) {
  const frame = vectorTypeFrame(font, cfg, t)
  const place = vtPlacement(frame, BOX)
  const b = frame.outlines.bbox
  return {
    w: (b.maxX - b.minX) * place.scale,
    h: (b.maxY - b.minY) * place.scale,
    wght: frame.outlines.coords.wght,
    commands: frame.outlines.glyphs.reduce((n, g) => n + g.commands.length, 0),
  }
}

describe('vtThumbWord — the user\'s own word, not "Aa"', () => {
  it('falls back to "Type" for empty, blank and non-string text', () => {
    expect(vtThumbWord('')).toBe(VT_THUMB_FALLBACK)
    expect(vtThumbWord('   ')).toBe(VT_THUMB_FALLBACK)
    expect(vtThumbWord(undefined)).toBe(VT_THUMB_FALLBACK)
    expect(vtThumbWord(null)).toBe(VT_THUMB_FALLBACK)
    expect(vtThumbWord(42)).toBe(VT_THUMB_FALLBACK)
    expect(vtThumbWord({ text: 'no' })).toBe(VT_THUMB_FALLBACK)
  })

  it('shows the typed word, untouched when it fits', () => {
    expect(vtThumbWord('Sailor')).toBe('Sailor')
    expect(vtThumbWord('  Sailor  ')).toBe('Sailor')
    expect(vtThumbWord('Type')).toBe('Type')
  })

  it('takes the FIRST word of a phrase rather than a truncated phrase', () => {
    // "Hello Wo" would show a word the user never typed; "Hello" is one they did.
    expect(vtThumbWord('Hello World')).toBe('Hello')
    expect(vtThumbWord('one\ttwo\nthree')).toBe('one')
  })

  it('truncates a long word to six glyphs, with NO ellipsis', () => {
    const w = vtThumbWord('Typographic')
    expect(w).toBe('Typogr')
    expect([...w]).toHaveLength(VT_THUMB_MAX_GLYPHS)
    // An ellipsis is a glyph, and every glyph here is re-cut by the preset — a
    // weight wave would travel through it as if it were part of the word.
    expect(w).not.toMatch(/[….]/)
  })

  it('cuts on CODE POINTS, never mid-surrogate', () => {
    const src = '🅰🅱🅲🅳🅴🅵🅶🅷'
    const w = vtThumbWord(src)
    expect([...w]).toHaveLength(VT_THUMB_MAX_GLYPHS)
    expect(w).toBe('🅰🅱🅲🅳🅴🅵')
    // What a UTF-16 `.slice` would have done instead: half as many glyphs…
    expect([...src.slice(0, VT_THUMB_MAX_GLYPHS)]).toHaveLength(3)
    // …and, at an odd boundary, a trailing LONE HIGH SURROGATE handed to the shaper.
    const lastUnit = [...src.slice(0, 5)].at(-1)!.charCodeAt(0)
    expect(lastUnit).toBeGreaterThanOrEqual(0xd800)
    expect(lastUnit).toBeLessThanOrEqual(0xdbff)
  })

  it('honours an explicit max, and never returns nothing', () => {
    expect(vtThumbWord('Sailor', 3)).toBe('Sai')
    expect(vtThumbWord('Sailor', 0)).toBe('S')
    expect(vtThumbWord('Sailor', -5)).toBe('S')
  })
})

describe('vtThumbConfig — a REAL config, through the one render path', () => {
  const base = { slot: 'loop' as const, fontId: 'inter', text: 'Sailor' }

  it('is a config `mergeConfig` accepts unchanged — not a tile-shaped lookalike', () => {
    const cfg = vtThumbConfig({ ...base, presetId: 'weight-wave' })
    expect(mergeConfig(cfg)).toEqual(cfg)
  })

  it('fills exactly the named slot, at the tile\'s phase length — ONE preset move', () => {
    for (const slot of ['in', 'out', 'loop'] as const) {
      const cfg = vtThumbConfig({ ...base, slot, presetId: 'weight-in' })
      // No `stagger` key on the move's `params`: `mergeAnimSpec` does not store
      // one, so a tile config carrying it would be a config the studio could
      // never save.
      expect(cfg.motion.moves).toHaveLength(1)
      const mv = cfg.motion.moves[0]!
      // `at`/`loop` placement — `~/lib/studio/moves/merge`'s `resolvePlacement`
      // specialised to a single move with `longestIn: 0`: 'in' and 'loop' both
      // start at the clip start ('loop' is the one that keeps cycling); 'out'
      // is anchored to the end of the clip.
      const expectAt = slot === 'out' ? VT_THUMB_CYCLE.out - VT_THUMB_PHASE.out : 0
      expect(mv.at).toBeCloseTo(expectAt, 9)
      expect(mv.loop).toBe(slot === 'loop')
      expect(mv.kind).toBe('preset')
      expect(mv.presetId).toBe('weight-in')
      expect(mv.duration).toBe(VT_THUMB_PHASE[slot])
      expect(cfg.motion.duration).toBe(VT_THUMB_CYCLE[slot])
    }
  })

  it('a blank preset id makes a STILL tile — no slot, nothing animated', () => {
    for (const id of ['', '   ']) {
      const cfg = vtThumbConfig({ ...base, presetId: id })
      expect(cfg.motion.moves).toEqual([])
      expect(vtHasPreset(cfg)).toBe(false)
      expect(vtIsAnimated(cfg)).toBe(false)
    }
    expect(vtHasPreset(vtThumbConfig({ ...base, presetId: 'weight-wave' }))).toBe(true)
  })

  it('keeps the stagger at the studio\'s own default of 0', () => {
    // Task 7's fast-path fix is what makes an axis preset visible at delay 0. A
    // tile that switched the stagger on would advertise motion the user will not
    // get, because their config has delay 0 too.
    const cfg = vtThumbConfig({ ...base, presetId: 'weight-wave' })
    expect(cfg.motion.stagger).toEqual({ delay: 0, order: 'forward', seed: 0 })
    expect(vectorTypeFrame(font, cfg, 0.3).staggered).toBe(false)
  })

  it('carries the word, the user\'s axes and the fill; carries no tracks', () => {
    const cfg = vtThumbConfig({
      ...base, text: 'Typographic', presetId: 'weight-wave',
      axes: { wght: 700, opsz: 20 }, fill: '#ff0000',
    })
    expect(cfg.text).toBe('Typogr')
    expect(cfg.axes).toEqual({ wght: 700, opsz: 20 })
    // LIFTED, not stored raw: `config.fill` is a `Paint` as of Task 2, and a
    // tile assembles its config directly (there is no stored blob to merge), so
    // it goes through the same `mergeFill` `mergeConfig` uses. The colour the
    // caller asked for lands on `a`.
    expect(vtBaseAppearance(cfg).fill).toEqual({ ...DEFAULT_FILL, a: '#ff0000' })
    // The move built is a PRESET move, not a tracks one — no `tracks` array.
    expect(cfg.motion.moves.every(m => !m.tracks)).toBe(true)
    // No stroke LAYER at all — the tile never had one, and the migration must
    // not materialise a dead layer for a zero-width stroke (trap 4, rule 3).
    expect(vtBaseAppearance(cfg).strokeWidth).toBe(0)
    expect(cfg.appearance.map((l) => l.kind)).toEqual(['fill'])
    expect(cfg.align).toBe('center')
  })

  it('copies the axes rather than aliasing the caller\'s record', () => {
    const axes = { wght: 700 }
    const cfg = vtThumbConfig({ ...base, presetId: 'weight-wave', axes })
    axes.wght = 100
    expect(cfg.axes.wght).toBe(700)
  })

  it('a preset moves the AXES off the resting position the caller gave it', () => {
    const cfg = vtThumbConfig({ ...base, presetId: 'weight-wave', axes: { wght: 400 } })
    // Per GLYPH, not off `outlines.coords`: a travelling wave has no single
    // shaped position, so `coords` reports the resting one (canvas.ts nulls
    // `uniform` the moment two glyphs disagree). The deltas are where the wave is.
    const seen = new Set<number>()
    let shapings = 0
    for (let k = 0; k < 8; k++) {
      const frame = vectorTypeFrame(font, cfg, k * 0.1)
      shapings = Math.max(shapings, frame.shapings)
      for (const tr of frame.transforms) seen.add(tr.axes.wght ?? 0)
    }
    // The tile is not showing one frozen weight, and the run really is being
    // re-shaped at those positions rather than merely reporting them.
    expect(seen.size).toBeGreaterThan(3)
    expect(Math.min(...seen)).toBeLessThan(0)
    expect(Math.max(...seen)).toBeGreaterThan(0)
    expect(shapings).toBeGreaterThan(1)
  })
})

describe('vtThumbSize — the largest frame still fits the tile', () => {
  const availW = VT_THUMB_W - VT_THUMB_PAD * 2
  const availH = VT_THUMB_H - VT_THUMB_PAD * 2

  function fitted(spec: Parameters<typeof vtThumbConfig>[0]) {
    const base = vtThumbConfig(spec)
    return { ...base, size: vtThumbSize(font, base, BOX) }
  }

  it('fits EVERY frame of a loop, not just the resting one', () => {
    const cfg = fitted({ slot: 'loop', fontId: 'inter', text: 'Sailor', presetId: 'weight-wave' })
    for (let k = 0; k <= 60; k++) {
      const t = (VT_THUMB_CYCLE.loop * k) / 60
      const ink = inkBox(cfg, t)
      expect(ink.w).toBeLessThanOrEqual(availW + 1e-6)
      expect(ink.h).toBeLessThanOrEqual(availH + 1e-6)
    }
  })

  it('fits an entrance at BOTH ends — lightest cut and resting cut', () => {
    const cfg = fitted({ slot: 'in', fontId: 'inter', text: 'Sailor', presetId: 'weight-in' })
    for (const t of [0, 0.2, 0.45, 0.89, 1.5]) {
      const ink = inkBox(cfg, t)
      expect(ink.w).toBeLessThanOrEqual(availW + 1e-6)
      expect(ink.h).toBeLessThanOrEqual(availH + 1e-6)
    }
  })

  it('the ANIMATION is what is measured — a wave forces a smaller size than rest alone', () => {
    // The crest sits heavier than the resting weight, so it is wider. A fit
    // taken from the resting frame (or from a single t = 0 sample, where the
    // wave is at or below rest) would clip it.
    const still = vtThumbSize(font, vtThumbConfig({ slot: 'loop', fontId: 'inter', text: 'Sailor', presetId: '' }), BOX)
    const waved = vtThumbSize(font, vtThumbConfig({ slot: 'loop', fontId: 'inter', text: 'Sailor', presetId: 'weight-wave' }), BOX)
    expect(waved).toBeLessThan(still)
  })

  it('a longer word is set smaller, and a short one bigger', () => {
    const spec = { slot: 'loop' as const, fontId: 'inter', presetId: '' }
    const one = vtThumbSize(font, vtThumbConfig({ ...spec, text: 'S' }), BOX)
    const six = vtThumbSize(font, vtThumbConfig({ ...spec, text: 'Sailor' }), BOX)
    expect(six).toBeLessThan(one)
    // …and the long one is still legible rather than collapsed to a hairline.
    expect(six).toBeGreaterThan(6)
  })

  it('never returns Infinity or NaN, whatever it is handed', () => {
    const blank = vtThumbSize(font, vtThumbConfig({ slot: 'loop', fontId: 'inter', text: '   ', presetId: '' }), BOX)
    expect(Number.isFinite(blank)).toBe(true)
    // The fallback word renders nothing in this 8-glyph subset ("Type" has no
    // glyphs here) — a blank run must still yield a usable size, not Infinity.
    expect(blank).toBeGreaterThan(0)
    const tiny = vtThumbSize(font, vtThumbConfig({ slot: 'loop', fontId: 'inter', text: 'Sailor', presetId: '' }), { width: 0, height: 0, padding: 0 })
    expect(Number.isFinite(tiny)).toBe(true)
  })
})

describe('the tile SHOWS the thickening — the reason the component exists', () => {
  it('a Weight In tile re-cuts the same outlines: same commands, heavier stems', () => {
    const base = vtThumbConfig({ slot: 'in', fontId: 'inter', text: 'Sailor', presetId: 'weight-in' })
    const cfg = { ...base, size: vtThumbSize(font, base, BOX) }
    const start = inkBox(cfg, 0)
    const end = inkBox(cfg, VT_THUMB_PHASE.in)

    // Starts at the font's own lightest cut, ends at the user's resting weight.
    expect(start.wght).toBe(font.axes.find(a => a.tag === 'wght')!.min)
    expect(end.wght).toBe(font.axes.find(a => a.tag === 'wght')!.default)
    expect(end.wght).toBeGreaterThan(start.wght as number)
    // Same topology — gvar moved the points, it did not add any. If this ever
    // fails, the tile is animating between incompatible outlines.
    expect(end.commands).toBe(start.commands)
    // …and the run really is wider at the end, at ONE fixed size (the fit is
    // resolved once — a per-frame refit would cancel exactly this).
    expect(end.w).toBeGreaterThan(start.w)
  })

  it('a Grow tile and a Weight tile are NOT the same picture', () => {
    // The distinction the whole component is for: `grow-in` scales the unit and
    // leaves the letterforms alone; `weight-in` leaves the scale at 1 and
    // re-cuts the letterforms.
    const at = (presetId: string, t: number) => {
      const base = vtThumbConfig({ slot: 'in', fontId: 'inter', text: 'Sailor', presetId })
      const cfg = { ...base, size: vtThumbSize(font, base, BOX) }
      const frame = vectorTypeFrame(font, cfg, t)
      return {
        wght: frame.outlines.coords.wght,
        scale: frame.transforms[0]!.scale,
        commands: frame.outlines.glyphs.reduce((n, g) => n + g.commands.length, 0),
      }
    }
    const grow = at('grow-in', 0.1)
    const weight = at('weight-in', 0.1)
    expect(grow.scale).not.toBe(1)
    expect(grow.wght).toBe(font.axes.find(a => a.tag === 'wght')!.default)
    expect(weight.scale).toBe(1)
    expect(weight.wght).toBeLessThan(grow.wght as number)
    expect(weight.commands).toBe(grow.commands)
  })
})
