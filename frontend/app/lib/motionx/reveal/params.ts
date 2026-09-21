// A REVEAL is a whole-layer transition: every pixel of the layer is either shown, hidden, or
// (for Pixels) redrawn as characters, decided per frame from ONE animated number (the amount,
// 0 → 1) plus the look's dials. This file is the vocabulary; `dither.ts` is the mask maths;
// `pixels.ts` is the Pixels maths; `paint.ts` is the only canvas-aware part. Pure: no Vue, no DOM.
import { PIXEL_CHARS } from './pixels'

export type RevealStyle = 'pixels' | 'dissolve' | 'wipe' | 'dots'
/** `pixels` TRANSFORMS the element — it runs the ASCII shader over it; the other three MASK it
 *  — they only show or hide it. Pixels first: it is the default. */
export const REVEAL_STYLES: readonly RevealStyle[] = ['pixels', 'dissolve', 'wipe', 'dots']

/** The dials as the MATHS wants them: `cell` a fraction of the frame's width, `angle` radians. */
export interface RevealParams { style: RevealStyle; out: boolean; cell: number; drift: number; angle: number; softness: number; chars: number }
/** What the fold parks on a layer clone for one frame. Transient — never persisted. */
export interface MotionReveal extends RevealParams { amount: number; elapsed: number }

/** Defaults in STORED units (what `behaviour.params` holds and the inspector shows). */
export const REVEAL_DEFAULTS = { style: 'pixels' as RevealStyle, cell: 8, drift: 6, angle: 0, softness: 0.35 }
export const REVEAL_RANGES = { cell: [1, 40], drift: [0, 30], angle: [0, 360], softness: [0, 1] } as const

/** The stored cell default depends on the style: Pixels wants coarse blocks (24‰) to read as
 *  characters; the three mask styles keep the fine dither of the original default (8‰). */
export function revealCellDefault(style: RevealStyle): number {
  return style === 'pixels' ? 24 : REVEAL_DEFAULTS.cell
}

const num = (v: unknown, d: number, [lo, hi]: readonly [number, number]) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** A finite number whose rounded value names one of `PIXEL_CHARS`; anything else (missing,
 *  non-numeric, unknown, Custom) → 1 (Blocks). */
const charsOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  const rounded = Math.round(v)
  return PIXEL_CHARS.some((c) => c.value === rounded) ? rounded : 1
}

/**
 * Does this frame's motion use the Pixels style anywhere? — i.e. will painting it need the
 * ASCII shader? Asked by every EXPORT before its first frame, so the glyph atlas can be
 * awaited rather than landing half way through a bake and changing the look mid-sequence.
 *
 * Pure, and read through `revealParams` like everything else: a bar with no style stored is
 * a Pixels bar, because Pixels is the default.
 */
export function motionUsesPixels(
  behaviours: { kind: string; params?: Record<string, unknown> }[] | undefined,
): boolean {
  if (!behaviours) return false
  return behaviours.some((b) => b?.kind === 'dither' && revealParams(b.params).style === 'pixels')
}

/** The ONE reader of a dither bar's stored params. Unknown enum / non-finite number → default;
 *  out-of-range number → clamped. */
export function revealParams(params: Record<string, unknown> | undefined): RevealParams {
  const p = params ?? {}
  const style = (REVEAL_STYLES as readonly unknown[]).includes(p.style) ? (p.style as RevealStyle) : REVEAL_DEFAULTS.style
  return {
    style,
    out: p.dir === 'out',
    cell: num(p.cell, revealCellDefault(style), REVEAL_RANGES.cell) / 1000,
    drift: num(p.drift, REVEAL_DEFAULTS.drift, REVEAL_RANGES.drift),
    angle: (num(p.angle, REVEAL_DEFAULTS.angle, REVEAL_RANGES.angle) * Math.PI) / 180,
    softness: num(p.softness, REVEAL_DEFAULTS.softness, REVEAL_RANGES.softness),
    chars: charsOf(p.chars),
  }
}
