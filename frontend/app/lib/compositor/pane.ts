/**
 * Pane — the "gradient mosaic" cell fill for a generative `deal` layer. Where the
 * default deal paints each cell one SOLID from the vocabulary, Pane paints each cell
 * a TWO-INK LINEAR GRADIENT at one of only 8 crisp angles, the two inks blended the
 * SHORT way round the OKLCH hue wheel (see hueWalk) so the midpoint stays saturated
 * — a straight orange→blue chord goes grey; walking the hue keeps the colour.
 *
 * DOM-free + no draw engine — pure so it unit-tests without mounting anything. It
 * only READS the vocabulary's solid inks and the shared colour primitives; the deal
 * paint branch (drawLayerContent) hands the returned Gradient to paintTileBox, which
 * already knows how to draw a linear gradient into a corner-origin cell tile.
 */
import { hueWalk } from '~/lib/color/hueWalk'
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { dealVocabItems, type DealVocab } from '~/lib/compositor/dealVocab'
import type { Gradient } from '~/lib/compositor/paint'

/** The only angles a Pane cell can take. Limiting to horizontal / vertical / the
 *  four corner diagonals keeps neighbouring cell edges crisp (Pane's whole look). */
export const PANE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const

/** Used only when a vocabulary offers no solid inks at all (never for the real four,
 *  which are solids-first) — a graceful two-ink pair so the generator never throws. */
const FALLBACK_INKS = ['#3b82f6', '#f97316'] as const

/** A seeded value in [0,1) for a namespaced stream, so angle and the two ink picks
 *  never correlate (each has its own tag). Same rng the deal's picker/keep use. */
function rand(tag: string): number {
  return mulberry32(hashSeed(tag))()
}

/**
 * The hue-walked two-ink linear gradient this cell gets in a gradient mosaic.
 * Deterministic in (vocab, seed, cellIndex): pick two DISTINCT solid inks from the
 * vocabulary's palette on independent seeded streams, walk them the short way round
 * the OKLCH hue wheel over ~6 stops, at a seeded 8-way angle.
 *
 * Falls back gracefully when the vocabulary has fewer than two solid inks (a default
 * pair, or the one ink duplicated) rather than throwing.
 */
export function paneCellGradient(vocab: DealVocab, seed: number, cellIndex: number): Gradient {
  // Ink pool = the SOLID (string) paints of the vocabulary; gradients/patterns skipped.
  const inks = dealVocabItems(vocab)
    .map(it => it.paint)
    .filter((p): p is string => typeof p === 'string')

  let inkA: string, inkB: string
  if (inks.length === 0) {
    inkA = FALLBACK_INKS[0]; inkB = FALLBACK_INKS[1]
  } else if (inks.length === 1) {
    inkA = inks[0]!; inkB = inks[0]!            // one ink → duplicate (flat, but never throws)
  } else {
    const ia = Math.min(inks.length - 1, Math.floor(rand(`${seed}:pane-a:${cellIndex}`) * inks.length))
    let ib = Math.min(inks.length - 1, Math.floor(rand(`${seed}:pane-b:${cellIndex}`) * inks.length))
    if (ib === ia) ib = (ib + 1) % inks.length  // force a DISTINCT second ink
    inkA = inks[ia]!; inkB = inks[ib]!
  }

  const angle = PANE_ANGLES[Math.min(PANE_ANGLES.length - 1, Math.floor(rand(`${seed}:pane-ang:${cellIndex}`) * PANE_ANGLES.length))]!

  // hueWalk emits { pos, color }; the Gradient shape wants { offset, color }.
  const stops = hueWalk(inkA, inkB, 6, { arc: 'short' }).map(s => ({ offset: s.pos, color: s.color }))
  return { type: 'linear', angle, stops }
}
