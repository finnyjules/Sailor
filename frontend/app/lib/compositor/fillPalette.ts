/**
 * Pure helpers for the Frame FillControl's palette + gradient authoring:
 *  - `rollPaintItem(n)` deterministically picks a tasteful fill (Vessell pattern
 *    or a brand gradient) for the shuffle button — same N ⇒ same pick.
 *  - `gradientFromPaint(...)` normalizes any Paint into an editable multi-stop
 *    Gradient WITHOUT collapsing to two stops (preserves radial + extra stops).
 * Kept DOM-free so it unit-tests without mounting the component.
 */
import { PALETTE, VESSELL_FILLS } from '~/lib/spacetype/palette'
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import type { Fill } from '~/lib/spacetype/fillTile'
import type { Paint, Gradient } from '~/composables/useCompositorLayers'

/** Type-only guard (erased at build) so this stays free of the draw engine. */
function paintIsGradient(p: Paint | undefined): p is Gradient {
  return !!p && typeof p === 'object' && ((p as { type?: string }).type === 'linear' || (p as { type?: string }).type === 'radial')
}

// A few brand gradients mixed into the shuffle alongside the pattern palette.
export const ROLL_GRADIENTS: Gradient[] = [
  { type: 'linear', angle: 45, stops: [{ offset: 0, color: PALETTE.blue }, { offset: 1, color: PALETTE.mint }] },
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: PALETTE.coral }, { offset: 0.5, color: PALETTE.peach }, { offset: 1, color: PALETTE.yellow }] },
  { type: 'radial', stops: [{ offset: 0, color: PALETTE.pink }, { offset: 1, color: PALETTE.darkIndigo }] },
  { type: 'linear', angle: 135, stops: [{ offset: 0, color: PALETTE.periwinkle }, { offset: 1, color: PALETTE.purple }] },
]

export const ROLLS: (Fill | Gradient)[] = [...VESSELL_FILLS, ...ROLL_GRADIENTS]

/** Deterministically pick a fill/gradient for roll N (seeded → same N, same pick). */
export function rollPaintItem(n: number): Fill | Gradient {
  const idx = Math.floor(mulberry32(hashSeed('fill-shuffle:' + n))() * ROLLS.length) % ROLLS.length
  // Return a deep copy so callers can mutate freely without touching the table.
  const pick = ROLLS[idx]!
  return paintIsGradient(pick) ? { ...pick, stops: pick.stops.map(s => ({ ...s })) } as Gradient : { ...pick }
}

/** Normalize any Paint into an editable multi-stop Gradient. Radial stays radial,
 *  extra stops are preserved; a non-gradient seeds a 2-stop linear from a/b. */
export function gradientFromPaint(p: Paint | undefined, a: string, b: string, angle: number): Gradient {
  if (paintIsGradient(p)) {
    const stops = (p.stops?.length ?? 0) >= 2 ? p.stops.map(s => ({ ...s })) : [{ offset: 0, color: a }, { offset: 1, color: b }]
    const g: Gradient = p.type === 'radial'
      ? { type: 'radial', stops }
      : { type: 'linear', angle: (p as { angle?: number }).angle ?? angle, stops }
    // Carry the hue-walk interpolation choice through the normalizer. Without this,
    // gradientFromPaint (the sole read-back path via FillControl.toGrad) strips the
    // Interpolation mode + author stops, so the control silently reverts to Direct on
    // the next reactive re-feed and eventually bakes over the user's authored colours.
    const src = p as { interp?: unknown; interpBase?: unknown }
    if (src.interp) {
      ;(g as { interp?: unknown; interpBase?: unknown }).interp = src.interp
      ;(g as { interp?: unknown; interpBase?: unknown }).interpBase = src.interpBase
    }
    return g
  }
  return { type: 'linear', angle, stops: [{ offset: 0, color: a }, { offset: 1, color: b }] }
}
