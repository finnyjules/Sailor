/**
 * Vector Type Studio — what a preset TILE shows. PURE.
 *
 * `motion/PresetThumb.vue` draws an abstract rounded card with "Aa" printed on
 * it. For Slide and Fade that is honest: the motion IS the whole story and the
 * card is a stand-in for any unit. For an AXIS preset it communicates nothing —
 * "Weight In" as a card that grows slightly is indistinguishable from "Grow",
 * and the entire point (letterforms thickening, or GRAD changing weight WITHOUT
 * reflowing the line) is invisible. The axis section is the reason this studio
 * exists, so its tiles have to show real letterforms being re-cut.
 *
 * This module is the pure half of that tile: word → config → size. It has no
 * canvas and no DOM, so the three decisions a thumbnail actually gets wrong —
 * which word, how long a word is allowed to be, and how big to set it — are
 * testable without a browser. `VectorTypeThumb.vue` is the thin wrapper that
 * feeds the result to `drawVectorTypeToCanvas` on the shared thumb clock.
 *
 * ## Three decisions, spelled out
 *
 * ### 1. The user's OWN word, not "Aa"
 *
 * Stolen from `TextEffectGalleryModal`, which live-renders the typed word in
 * every card so you pick by seeing YOUR text in each style. Same argument here,
 * doubled: a weight wave's shape depends on how many letters it travels through,
 * so a two-letter stand-in would mis-sell the one preset the section is for.
 * Falls back to `Type` when the config's text is empty — a blank tile reads as a
 * broken feature.
 *
 * ### 2. Truncate to a word AND fit to the box — both, deliberately
 *
 * A 72×54 tile has room for about six glyphs before the letterforms are too
 * small for a weight change to read, and fit-to-box alone would happily set a
 * 40-character headline at 3px per glyph: technically not overflowing, and
 * useless. So the string is cut to its FIRST whitespace-delimited word and then
 * to `VT_THUMB_MAX_GLYPHS` code points, and the surviving glyphs are fitted.
 *
 * No ellipsis is appended. An ellipsis is a glyph, and every glyph in this tile
 * gets re-cut by the axis preset — a travelling weight wave would run through a
 * "…" as if it were part of the word.
 *
 * ### 3. The size is resolved ONCE, over the whole cycle — never per frame
 *
 * A per-frame fit would rescale the run to the box every frame and therefore
 * CANCEL EXACTLY WHAT THE TILE IS FOR: letters that thicken would be shrunk to
 * compensate, and Weight Wave would render as a word that visibly does nothing.
 * So `vtThumbSize` samples the animation across the cycle, takes the frame whose
 * ink is largest, and that one size is used for every frame — the growth stays
 * visible and the worst frame still fits.
 *
 * Only the run's own INK is fitted. A preset's per-glyph OFFSETS (a slide's `dy`)
 * are not, on purpose: a slide is supposed to carry the letters in from outside
 * the frame, exactly as the real render does.
 */
import { vectorTypeFrame } from './canvas'
import {
  DEFAULT_CONFIG,
  DEFAULT_MOTION,
  DEFAULT_STAGGER,
  migrateLegacyAppearance,
  type VectorTypeConfig,
  type VtMove,
  type VtPresetSlot,
} from './config'
import type { VtFont } from './font'
import type { Paint } from '~/lib/compositor/paint'

/** Tile size in CSS pixels — `PresetThumb`'s, so the two can sit in one grid. */
export const VT_THUMB_W = 72
export const VT_THUMB_H = 54
/** Kept clear on every side, so a heavy cut does not touch the tile's border. */
export const VT_THUMB_PAD = 5

/** Glyphs a tile will set. Six fits "Vector" (the studio's own default text) and
 *  is enough letters for a travelling wave to read as travelling. */
export const VT_THUMB_MAX_GLYPHS = 6
/** Shown when the config's text is empty. `TextEffectGalleryModal`'s word. */
export const VT_THUMB_FALLBACK = 'Type'

/** Tile loop length per slot — `PresetThumb`'s cycles, so a Vector Type tile and
 *  an engine tile in the same gallery beat together. */
export const VT_THUMB_CYCLE: Readonly<Record<VtPresetSlot, number>> = Object.freeze({
  in: 2, out: 2, loop: 1.5,
})
/** The preset's own phase length inside that cycle. `in` plays then holds;
 *  `out` holds then plays (it is anchored to the end of the clip); a loop fills
 *  the cycle so the tile's period IS the preset's period. */
export const VT_THUMB_PHASE: Readonly<Record<VtPresetSlot, number>> = Object.freeze({
  in: 0.9, out: 0.9, loop: 1.5,
})

/** Frames sampled when fitting. Seven is enough to catch a sine's crest to
 *  within a fraction of a percent of the run's width, and each sample costs a
 *  real shaping — a gallery of tiles pays this once per tile on font load. */
const FIT_SAMPLES = 7
/**
 * Slack on the fitted size, for what the sampling cannot see.
 *
 * A sampled maximum is a lower bound on the true one: the widest instant of a
 * loop falls BETWEEN samples, and the run keeps widening for a fraction of a
 * step past the last one measured. At seven samples of a full sine that gap is
 * under 0.1% of the run's width on the fonts to hand, so 2% is a wide margin —
 * and 2% of a 62px run is a pixel, which is cheaper than a clipped letterform.
 */
const FIT_SAFETY = 0.98

/**
 * The word a tile sets: the config's first word, cut to `max` code points,
 * falling back to `VT_THUMB_FALLBACK`.
 *
 * Code points, not `String.slice` — a `.slice(0, 6)` through an astral character
 * (an emoji, an emoji with a modifier) cuts a surrogate pair in half and hands
 * the shaper a lone surrogate.
 */
export function vtThumbWord(text: unknown, max: number = VT_THUMB_MAX_GLYPHS): string {
  const raw = typeof text === 'string' ? text : ''
  const first = raw.trim().split(/\s+/)[0] ?? ''
  const cps = [...first]
  if (!cps.length) return VT_THUMB_FALLBACK
  return cps.slice(0, Math.max(1, Math.floor(max))).join('')
}

export interface VtThumbSpec {
  /** The preset the tile is advertising. Empty/blank = a STILL tile: the word at
   *  rest, with no slot filled. That is what an unavailable axis preset shows —
   *  the user's own word, un-animated, next to the reason it cannot run. */
  presetId: string
  slot: VtPresetSlot
  /** Catalog font id. Carried into the config so `vtExportName`-style consumers
   *  and any future re-resolve see the same font the tile drew with. */
  fontId: string
  /** The studio's live text. Truncated by `vtThumbWord`. */
  text?: string
  /** Where the user has parked the axes. A preset is a DELTA on this (Task 7),
   *  so a tile that ignored it would advertise motion from a weight the user is
   *  not at. */
  axes?: Record<string, number> | null
  /** Glyph paint. A `Paint`, not a colour, because the surface hands its own
   *  `config.fill` straight in (`VectorTypeSurface.vue:850,1025`) — a tile that
   *  narrowed it to a string would be the fifth render path this file's header
   *  refuses. Defaults to the tile's white-on-dark. */
  fill?: Paint
  /** Em size in tile pixels. Normally left to `vtThumbSize`. */
  size?: number
}

/**
 * The config a tile renders — a real `VectorTypeConfig`, so the tile goes
 * through `drawVectorType` exactly as the surface, the node card, the baker and
 * the frame source do. No fifth render path: that is the "Smart Layout render
 * parity" rule, and a tile that lied about what a preset does would be the worst
 * place to break it.
 *
 * `stagger.delay` stays 0 — the studio's default. Task 7's fast-path fix is what
 * makes an axis preset visible there, and a tile that quietly switched the
 * stagger on would advertise motion the user will not get.
 *
 * ONE preset move, not a slot spec. `motion.in`/`out`/`loop` are gone (see
 * `./config.ts`'s `VtMotionConfig.moves`); a tile now builds exactly the move
 * `mergeConfig` would itself build from an equivalent slot, and MUST — the
 * round-trip test (`mergeConfig(cfg)).toEqual(cfg)`) pins that this file's
 * output is byte-identical to what the merge would rebuild it into, since
 * `mergeMove` re-validates every field of an already-`at`/`loop`/`bounce`-
 * shaped `motion`. This file therefore builds `at`/`loop` DIRECTLY rather
 * than a `phase`/`play` pair for `mergeMove` to convert (there is nothing
 * upstream of a tile to convert FROM): `~/lib/studio/moves/merge`'s
 * `resolvePlacement`, specialised to a single move with `longestIn: 0` (a
 * tile never has a co-existing 'in' move) — `in` -> `at: 0`; `out` -> `at:
 * clipDuration - duration` (the slot's own duration already fits inside its
 * cycle, so the window is never compressed); `loop` -> `at: 0, loop: true`.
 * `ease: 'none'` keeps the preset's own progress un-warped — the same LINEAR
 * progress the old per-slot reader always fed an axis preset's `fn` (see
 * `vtAxisDelta`'s caller, `presetTransform`) — so a tile's animation is not
 * shaped differently from what a fresh preset pick in the studio itself would
 * play at `ease: 'none'`, the default this file's callers hand a picked
 * preset before the user ever touches the Ease dial.
 */
export function vtThumbConfig(spec: VtThumbSpec): VectorTypeConfig {
  const slot: VtPresetSlot = spec.slot
  const presetId = typeof spec.presetId === 'string' ? spec.presetId.trim() : ''
  // No `stagger` on the spec, matching the old slot's contract: Vector Type has
  // the richer `motion.stagger`, and `vtPresetSpecs` forces the engine's to 0,
  // so carrying one here would make the tile's config differ from any config
  // the studio can actually save.
  const duration = VT_THUMB_PHASE[slot]
  const at = slot === 'out' ? Math.max(0, VT_THUMB_CYCLE[slot] - duration) : 0
  const moves: VtMove[] = presetId
    ? [{
        id: 'thumb',
        at,
        kind: 'preset',
        presetId,
        duration,
        loop: slot === 'loop',
        ease: { kind: 'named', name: 'none' },
      }]
    : []
  return {
    ...DEFAULT_CONFIG,
    text: vtThumbWord(spec.text),
    fontId: spec.fontId,
    axes: { ...(spec.axes ?? {}) },
    size: Number.isFinite(spec.size) ? (spec.size as number) : 24,
    tracking: 0,
    align: 'center',
    // Through the SAME migration `mergeConfig` uses, not a hand-built layer: a
    // tile config is asserted to be one `mergeConfig` accepts UNCHANGED, so the
    // stack it carries — layer id included — has to be byte-identical to the one
    // the merge would build. This file is the read path that BYPASSES
    // `mergeConfig` entirely (it builds a config rather than loading one), which
    // is exactly where the previous config migration on this module found its one
    // real gap. `||` keeps the old empty-string-means-default behaviour (an
    // object is truthy, so a real `Paint` passes through it untouched).
    appearance: migrateLegacyAppearance({ fill: spec.fill || '#ffffff', strokeWidth: 0 }),
    motion: {
      ...DEFAULT_MOTION,
      moves,
      duration: VT_THUMB_CYCLE[slot],
      stagger: { ...DEFAULT_STAGGER },
    },
  }
}

export interface VtThumbBox {
  width?: number
  height?: number
  padding?: number
}

/**
 * The em size, in tile pixels, at which the LARGEST frame of this animation
 * still fits the tile.
 *
 * Sampled across the cycle rather than read off the resting frame, because the
 * frames differ in ink: Weight Wave's crest is wider than its rest, Width
 * Breathe's is wider still, and a fit taken at rest alone would clip them. Five
 * samples of the run's own bbox; the smallest size any of them permits wins.
 *
 * Returns a size, never a mutated config — the caller decides what to do with
 * it, and the value is stable for as long as the word, font, axes and preset are.
 */
export function vtThumbSize(
  font: VtFont,
  cfg: VectorTypeConfig,
  box: VtThumbBox = {},
): number {
  const W = Number.isFinite(box.width) ? (box.width as number) : VT_THUMB_W
  const H = Number.isFinite(box.height) ? (box.height as number) : VT_THUMB_H
  const pad = Number.isFinite(box.padding) ? (box.padding as number) : VT_THUMB_PAD
  const availW = Math.max(1, W - pad * 2)
  const availH = Math.max(1, H - pad * 2)
  // Measured at a fixed probe size: `size` scales the run uniformly and does not
  // change its outlines, so one probe answers for every size.
  const probe: VectorTypeConfig = { ...cfg, size: 100 }
  const cycle = Math.max(0.001, probe.motion.duration)

  let best = Infinity
  for (let k = 0; k < FIT_SAMPLES; k++) {
    const t = (cycle * k) / FIT_SAMPLES
    const frame = vectorTypeFrame(font, probe, t)
    const b = frame.outlines.bbox
    const upem = frame.outlines.unitsPerEm || 1000
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    if (!(w > 0) || !(h > 0)) continue
    // inkPx = (units / upem) * size  ≤  avail   →   size ≤ avail * upem / units
    best = Math.min(best, (availW * upem) / w, (availH * upem) / h)
  }
  // Every sampled frame was blank (an all-space word): any size draws nothing,
  // so return something sane rather than Infinity.
  if (!Number.isFinite(best)) return availH
  return Math.max(1, Math.min(400, best * FIT_SAFETY))
}
