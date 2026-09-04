/**
 * Deal-grid vocabularies — the weighted fill palettes a single self-painting
 * `deal` layer draws every grid cell from (see DealLayer in useCompositorLayers).
 *
 * A vocabulary is a small WEIGHTED list of Paints (solid brand colours plus a few
 * curated pattern/gradient fills). The seeded picker below draws a cell's fill from
 * that list deterministically: same (vocab, seed, cellIndex) ⇒ same Paint, so one
 * "New variation" (a fresh seed) re-rolls the whole grid coherently while any other
 * edit leaves the deal identical.
 *
 * DOM-free + no draw engine — pure so it unit-tests without mounting anything. v1
 * keeps the vocabulary to SOLID + simple curated fills (no per-cell live shaders),
 * which is why the deal layer needs no shader-field plumbing (layerPaints('deal')
 * returns []). A future "shader" vocabulary would add ShaderSpec fills here and
 * return them from layerPaints so the field pre-pass can register them.
 */
import { PALETTE, VESSELL_FILLS } from '~/lib/spacetype/palette'
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import type { Fill } from '~/lib/spacetype/fillTile'
import type { Paint, Gradient } from '~/lib/compositor/paint'

/** The named vocabularies a deal layer can draw from. */
export type DealVocab = 'brand' | 'mono' | 'warm' | 'cool'
export const DEAL_VOCABS: readonly DealVocab[] = ['brand', 'mono', 'warm', 'cool'] as const

/** One entry in a vocabulary: a Paint and its relative weight (bigger = more often). */
interface WeightedPaint { paint: Paint; weight: number }

/** A patterned Fill literal in the deal's own colours (textColor is unused when
 *  painting a cell, but the Fill shape requires it). */
function pat(type: Fill['type'], a: string, b: string, density = 6): Fill {
  return { type, a, b, textColor: PALETTE.charcoal, angle: 45, density }
}
/** A 2-stop linear gradient literal. */
function lin(a: string, b: string, angle = 45): Gradient {
  return { type: 'linear', angle, stops: [{ offset: 0, color: a }, { offset: 1, color: b }] }
}

/**
 * The vocabularies. Each is a weighted list so a deal reads as a designed palette,
 * not a uniform shuffle — solids dominate, patterns/gradients punctuate. Keep them
 * short and tasteful; extend by adding entries (order/weights are the only tuning).
 */
const VOCAB_ITEMS: Record<DealVocab, WeightedPaint[]> = {
  // Full Vessell brand mix — the default look behind Oddgrid/Modular.
  brand: [
    { paint: PALETTE.blue, weight: 4 },
    { paint: PALETTE.coral, weight: 4 },
    { paint: PALETTE.yellow, weight: 3 },
    { paint: PALETTE.mint, weight: 3 },
    { paint: PALETTE.pink, weight: 3 },
    { paint: PALETTE.periwinkle, weight: 3 },
    { paint: PALETTE.darkIndigo, weight: 2 },
    { paint: { ...VESSELL_FILLS[1]! }, weight: 1 }, // stripes pink/coral
    { paint: { ...VESSELL_FILLS[2]! }, weight: 1 }, // grid coral/peach
    { paint: lin(PALETTE.blue, PALETTE.mint, 45), weight: 1 },
  ],
  // Monochrome — greys, paper tones, ink. Calm, editorial.
  mono: [
    { paint: PALETTE.charcoal, weight: 4 },
    { paint: PALETTE.gray, weight: 4 },
    { paint: PALETTE.beige, weight: 3 },
    { paint: PALETTE.lavender, weight: 3 },
    { paint: '#ffffff', weight: 3 },
    { paint: '#1a1a1a', weight: 2 },
    { paint: pat('stripes', PALETTE.charcoal, PALETTE.gray), weight: 1 },
    { paint: pat('checkerboard', '#1a1a1a', PALETTE.beige), weight: 1 },
  ],
  // Warm — corals, peaches, yellows, browns; a sunset gradient.
  warm: [
    { paint: PALETTE.coral, weight: 4 },
    { paint: PALETTE.peach, weight: 4 },
    { paint: PALETTE.yellow, weight: 3 },
    { paint: PALETTE.pink, weight: 3 },
    { paint: PALETTE.darkBrown, weight: 2 },
    { paint: PALETTE.darkIndigo, weight: 1 },
    { paint: pat('grid', PALETTE.coral, PALETTE.peach), weight: 1 },
    { paint: lin(PALETTE.coral, PALETTE.yellow, 90), weight: 1 },
  ],
  // Cool — blues, teals, mints, purples; an ocean gradient.
  cool: [
    { paint: PALETTE.blue, weight: 4 },
    { paint: PALETTE.teal, weight: 4 },
    { paint: PALETTE.mint, weight: 3 },
    { paint: PALETTE.periwinkle, weight: 3 },
    { paint: PALETTE.purple, weight: 2 },
    { paint: PALETTE.darkNavy, weight: 2 },
    { paint: pat('stripes', PALETTE.blue, PALETTE.mint), weight: 1 },
    { paint: lin(PALETTE.teal, PALETTE.periwinkle, 45), weight: 1 },
  ],
}

/** Normalize a possibly-unknown vocab name to a real one (unknown ⇒ 'brand'). */
export function normalizeVocab(v: unknown): DealVocab {
  return (DEAL_VOCABS as readonly string[]).includes(v as string) ? (v as DealVocab) : 'brand'
}

/** The weighted entries for a vocabulary (defaults to 'brand' for an unknown name). */
export function dealVocabItems(vocab: DealVocab): WeightedPaint[] {
  return VOCAB_ITEMS[normalizeVocab(vocab)]
}

/** How many distinct Paints a vocabulary offers (for tests / UI hints). */
export function dealVocabSize(vocab: DealVocab): number {
  return dealVocabItems(vocab).length
}

/** Deep-copy a Paint so callers can mutate the returned fill without touching the
 *  vocabulary table (strings are immutable, objects are JSON-cloned). */
function clonePaint(p: Paint): Paint {
  return typeof p === 'string' ? p : (JSON.parse(JSON.stringify(p)) as Paint)
}

/**
 * The index into `dealVocabItems(vocab)` this cell draws — a seeded WEIGHTED pick.
 * Deterministic in (vocab, seed, cellIndex). Exposed alongside pickDealPaint so a
 * test can assert the (kept, paintIndex) sequence without comparing Paint objects.
 */
export function pickDealIndex(vocab: DealVocab, seed: number, cellIndex: number): number {
  const items = dealVocabItems(vocab)
  const total = items.reduce((a, it) => a + it.weight, 0)
  if (total <= 0) return 0
  let r = mulberry32(hashSeed(`${seed}:fill:${cellIndex}`))() * total
  for (let i = 0; i < items.length; i++) {
    r -= items[i]!.weight
    if (r < 0) return i
  }
  return items.length - 1
}

/** The Paint this cell is dealt — a deep copy of the weighted pick. */
export function pickDealPaint(vocab: DealVocab, seed: number, cellIndex: number): Paint {
  const items = dealVocabItems(vocab)
  return clonePaint(items[pickDealIndex(vocab, seed, cellIndex)]!.paint)
}

/**
 * Whether this cell is FILLED under `density` (0..1 fraction kept). A separate
 * seeded stream from the fill pick ('keep' vs 'fill'), so changing density never
 * shuffles which Paint a kept cell gets. density>=1 keeps all; density<=0 keeps none.
 */
export function keptCell(seed: number, cellIndex: number, density: number): boolean {
  if (!(density < 1)) return true      // >=1 (and NaN-safe) keeps every cell
  if (density <= 0) return false
  return mulberry32(hashSeed(`${seed}:keep:${cellIndex}`))() < density
}

/**
 * The one cell force-kept so a deal never renders FULLY blank at a low (but > 0)
 * density — the minimum keep-hash cell (the one most likely already kept, so the
 * guarantee is visually seamless). Deterministic in (seed, cellCount). Returns -1
 * for an empty grid. Callers apply it only when density > 0, so an explicit
 * density of 0 still means an empty deal.
 */
export function forceKeptCell(seed: number, cellCount: number): number {
  if (cellCount <= 0) return -1
  let best = 0
  let bestHash = Infinity
  for (let i = 0; i < cellCount; i++) {
    const h = mulberry32(hashSeed(`${seed}:keep:${i}`))()
    if (h < bestHash) { bestHash = h; best = i }
  }
  return best
}
