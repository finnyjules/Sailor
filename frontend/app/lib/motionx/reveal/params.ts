// A REVEAL is a whole-layer transition: every pixel of the layer is either shown, hidden, or
// (for Pixels) redrawn as characters, decided per frame from ONE animated number (the amount,
// 0 → 1) plus the look's dials. This file is the vocabulary; `dither.ts` is the mask maths;
// `pixels.ts` is the Pixels maths; `paint.ts` is the only canvas-aware part. Pure: no Vue, no DOM.
import { PIXEL_CHARS } from './pixels'
import { DITHER_PATTERNS } from './assemble'

export type RevealStyle = 'pixels' | 'assemble' | 'dissolve' | 'wipe' | 'dots'
/** `pixels` and `assemble` TRANSFORM the element — they run a shader over it; the other three
 *  MASK it — they only show or hide it. Pixels first: it is the default; Assemble second. */
export const REVEAL_STYLES: readonly RevealStyle[] = ['pixels', 'assemble', 'dissolve', 'wipe', 'dots']

/** Assemble's block look: `dither` samples the Shader Studio Dither effect, `characters` runs
 *  the ASCII effect at full density. */
export type RevealLook = 'dither' | 'characters'
export const REVEAL_LOOKS: readonly RevealLook[] = ['dither', 'characters']

/** The Custom character set's fallback — the picture is built from these when `customChars`
 *  is absent, not a string, or empty once cleaned. Duplicated from `~/lib/shaderfx/customGlyphs`'s
 *  own `DEFAULT_CUSTOM_CHARS` rather than imported: that module rasterizes glyphs onto a real
 *  `<canvas>`, and this barrel (`~/lib/motionx/reveal`) is deliberately DOM-free — every non-paint
 *  file in this folder is safe to import from a server/bake context with no DOM at all. A unit
 *  test (`reveal-pixels.unit.spec.ts`) asserts the two constants stay equal. */
export const DEFAULT_CUSTOM_CHARS = ' .:-=+*#%@'

/** The dials as the MATHS wants them: `cell` a fraction of the frame's width, `angle` radians,
 *  `band`/`scatter` 0..1 fractions of the travel (Assemble only). */
export interface RevealParams {
  style: RevealStyle
  out: boolean
  cell: number
  drift: number
  angle: number
  softness: number
  chars: number
  /** The Custom shape's (value 14) own glyph string — read and cleaned regardless of which
   *  `chars` value is stored, so switching TO Custom shows whatever was last typed rather than
   *  the default reappearing. Never empty once read through `revealParams` (the ONE reader,
   *  which always fills it in via `cleanCustomChars`): an emptied field is stored as `''`,
   *  which reads back as `DEFAULT_CUSTOM_CHARS`. Optional on the TYPE only — not because a
   *  reveal can lack it, but so the one existing hand-built `MotionReveal` literal outside this
   *  folder (the Assemble gallery tile's preview maths, which never needs a glyph sheet) is not
   *  forced to name a field it has no use for; every consumer that cares treats it as present. */
  customChars?: string
  look: RevealLook
  pattern: number
  levels: number
  band: number
  scatter: number
}
/** What the fold parks on a layer clone for one frame. Transient — never persisted. */
export interface MotionReveal extends RevealParams { amount: number; elapsed: number }

/** Defaults in STORED units (what `behaviour.params` holds and the inspector shows). `band`
 *  and `scatter` are stored as 0–100 percentages; `revealParams` divides by 100. */
export const REVEAL_DEFAULTS = {
  style: 'pixels' as RevealStyle, cell: 8, drift: 6, angle: 0, softness: 0.35,
  look: 'dither' as RevealLook, pattern: 2, levels: 3, band: 30, scatter: 35,
}
export const REVEAL_RANGES = {
  cell: [1, 40], drift: [0, 30], angle: [0, 360], softness: [0, 1],
  pattern: [0, 11], levels: [2, 8], band: [0, 100], scatter: [0, 100],
} as const

/** The stored cell default depends on the style: Pixels wants coarse blocks (24‰) to read as
 *  characters; Assemble's constant block defaults to 16‰; the three mask styles keep the fine
 *  dither of the original default (8‰). */
export function revealCellDefault(style: RevealStyle): number {
  if (style === 'pixels') return 24
  if (style === 'assemble') return 16
  return REVEAL_DEFAULTS.cell
}

const num = (v: unknown, d: number, [lo, hi]: readonly [number, number]) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** A finite number whose rounded value names one of `PIXEL_CHARS` (Custom, value 14, included);
 *  anything else (missing, non-numeric, unknown) → 1 (Blocks). */
const charsOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  const rounded = Math.round(v)
  return PIXEL_CHARS.some((c) => c.value === rounded) ? rounded : 1
}

/** Control characters (Unicode category Cc — this covers every ASCII/C1 control, tabs and
 *  \r\n included) and the two Unicode line/paragraph separators outside that category. */
const CUSTOM_CHARS_STRIP = /[\p{Cc}\u2028\u2029]/gu

/** `customChars` cleaning: a string, control characters and line breaks stripped, trimmed of
 *  NOTHING else — a leading/trailing space is a real, lightest-tone glyph, not padding — capped
 *  at 64 CODE POINTS (not UTF-16 units, so one emoji is one character). Non-string, or empty
 *  once cleaned, → `DEFAULT_CUSTOM_CHARS`; an emptied field is stored as `''` and reads back as
 *  the default rather than persisting it, so storage never gains a copy of the default string. */
export function cleanCustomChars(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_CUSTOM_CHARS
  const stripped = v.replace(CUSTOM_CHARS_STRIP, '')
  const capped = Array.from(stripped).slice(0, 64).join('')
  return capped.length > 0 ? capped : DEFAULT_CUSTOM_CHARS
}

/** A finite number whose rounded value names one of `DITHER_PATTERNS`; anything else (missing,
 *  non-numeric, out of range) → the default pattern. It is an enum like `style`, not a clamped
 *  range: an unknown value must fall back, not land on the nearest valid pattern. */
const patternOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return REVEAL_DEFAULTS.pattern
  const rounded = Math.round(v)
  return DITHER_PATTERNS.some((p) => p.value === rounded) ? rounded : REVEAL_DEFAULTS.pattern
}

/** Does this style TRANSFORM the element (Pixels, Assemble — the side-canvas route, a shader
 *  run over the layer's own pixels) rather than merely MASK it? The compositor asks before it
 *  decides which route a bar takes, so this lives here, in the DOM-free half of the folder,
 *  and not beside the canvas code it steers. */
export function isShaderRevealStyle(style: RevealStyle): boolean {
  return style === 'pixels' || style === 'assemble'
}

/**
 * Does this frame's motion use a SHADER style anywhere — Pixels or Assemble — i.e. will
 * painting it need the ASCII or Dither shader? Asked by every EXPORT before its first frame,
 * so the glyph atlas (or shader) can be awaited rather than landing half way through a bake
 * and changing the look mid-sequence.
 *
 * Pure, and read through `revealParams` like everything else: a bar with no style stored is
 * a Pixels bar, because Pixels is the default.
 */
export function motionUsesShaderStyle(
  behaviours: { kind: string; params?: Record<string, unknown> }[] | undefined,
): boolean {
  if (!behaviours) return false
  return behaviours.some((b) => {
    if (b?.kind !== 'dither') return false
    return isShaderRevealStyle(revealParams(b.params).style)
  })
}
/** Alias kept so existing callers (written before Assemble) still compile and behave the same
 *  for the styles they knew about. */
export const motionUsesPixels = motionUsesShaderStyle

/** The ONE reader of a dither bar's stored params. Unknown enum / non-finite number → default;
 *  out-of-range number → clamped. */
export function revealParams(params: Record<string, unknown> | undefined): RevealParams {
  const p = params ?? {}
  const style = (REVEAL_STYLES as readonly unknown[]).includes(p.style) ? (p.style as RevealStyle) : REVEAL_DEFAULTS.style
  const look = (REVEAL_LOOKS as readonly unknown[]).includes(p.look) ? (p.look as RevealLook) : REVEAL_DEFAULTS.look
  return {
    style,
    out: p.dir === 'out',
    cell: num(p.cell, revealCellDefault(style), REVEAL_RANGES.cell) / 1000,
    drift: num(p.drift, REVEAL_DEFAULTS.drift, REVEAL_RANGES.drift),
    angle: (num(p.angle, REVEAL_DEFAULTS.angle, REVEAL_RANGES.angle) * Math.PI) / 180,
    softness: num(p.softness, REVEAL_DEFAULTS.softness, REVEAL_RANGES.softness),
    chars: charsOf(p.chars),
    customChars: cleanCustomChars(p.customChars),
    look,
    pattern: patternOf(p.pattern),
    levels: Math.round(num(p.levels, REVEAL_DEFAULTS.levels, REVEAL_RANGES.levels)),
    band: num(p.band, REVEAL_DEFAULTS.band, REVEAL_RANGES.band) / 100,
    scatter: num(p.scatter, REVEAL_DEFAULTS.scatter, REVEAL_RANGES.scatter) / 100,
  }
}
