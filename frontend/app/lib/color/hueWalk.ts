// The hue-walk ramp primitive. Pure — no Vue, no DOM.
//
// Expands two hex colours into an evenly-spaced ramp that carries chroma all the
// way across by WALKING the hue in OKLCH — a rotation round the colour wheel —
// instead of cutting the straight sRGB (or OKLab) chord, which desaturates
// through the middle. The arc can go the short way or the long way (see hue.ts).
//
// This is `composed.ts`'s two-seed trick (walk A→B hue over N stops, optionally
// the long way) generalised into a reusable stop-expander, built on the shared
// `walkHue` so the arc direction lives in exactly one place.

import { hexToOklch, oklchToHexInGamut, parseHexA, withAlpha } from './convert'
import type { GradientStop } from './harmony'
import { walkHue } from './hue'

/** Reuse harmony.ts's stop shape verbatim — `{ pos: 0..1, color }` — so a ramp
 *  from here drops into anything that already consumes `toStops`' output. */
export type RampStop = GradientStop

export interface HueWalkOpts {
  /** Which way round the wheel to rotate the hue. Default 'short'. */
  arc?: 'short' | 'long'
}

/**
 * Below this OKLCH chroma the hue angle is meaningless (a near-grey), and letting
 * it drive the walk would sweep a grey→colour ramp the long way through the whole
 * spectrum. Mirrors the powerless-hue guard in `mix.ts`: an achromatic endpoint
 * borrows its partner's hue so the ramp stays a clean chroma rise at one hue.
 */
const ACHROMATIC_C = 1e-4

/**
 * Expand `aHex`→`bHex` into `n` (≥2) evenly-spaced stops, walking hue along the
 * chosen arc in OKLCH while L and C lerp linearly. Emits IN-GAMUT hex via
 * `oklchToHexInGamut`, which preserves hue+lightness (reducing chroma when it
 * must) — the hue is the whole point of walking it.
 *
 * Endpoints are emitted as the original inputs (normalised through parseHexA), so
 * they round-trip exactly and `n === 2` returns just the two endpoints. Alpha on
 * either input is carried and lerped; the result is 6-digit whenever it lands
 * fully opaque, matching the rest of the colour module.
 */
export function hueWalk(aHex: string, bHex: string, n: number, opts?: HueWalkOpts): RampStop[] {
  const N = Math.max(2, Math.floor(n))
  const long = opts?.arc === 'long'

  const A = parseHexA(aHex)
  const B = parseHexA(bHex)
  const [L0, C0, H0] = hexToOklch(A.hex)
  const [L1, C1, H1] = hexToOklch(B.hex)

  // A near-grey endpoint has no usable hue — take the other end's so the walk is
  // a chroma ramp at a fixed hue, not a spin through the spectrum.
  const h0 = C0 < ACHROMATIC_C ? H1 : H0
  const h1 = C1 < ACHROMATIC_C ? H0 : H1

  const stops: RampStop[] = []
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    if (i === 0) { stops.push({ pos: 0, color: withAlpha(A.hex, A.alpha) }); continue }
    if (i === N - 1) { stops.push({ pos: 1, color: withAlpha(B.hex, B.alpha) }); continue }
    const L = L0 + (L1 - L0) * t
    const C = C0 + (C1 - C0) * t
    const H = walkHue(h0, h1, t, long)
    const alpha = A.alpha + (B.alpha - A.alpha) * t
    stops.push({ pos: t, color: withAlpha(oklchToHexInGamut(L, C, H), alpha) })
  }
  return stops
}
