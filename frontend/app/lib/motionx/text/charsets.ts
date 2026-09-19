// The character POOLS a letter behaviour substitutes from: Decode's flicker and the filler
// glyphs a Slot reel rolls through. Pure lookup — given a set, the real character being stood
// in for, the cells of the whole text, and a number in [0, 1), it hands back one character.
//
// `text` is the interesting one: standing a word's own letters in for each other keeps the
// churn looking like the same typeface and the same alphabet, where a fixed A–Z pool on a
// number or a piece of Greek would not. It needs at least two distinct characters to be a
// scramble at all, so a one-letter (or all-the-same) layer falls back to the alphabet.
export type Charset = 'text' | 'letters' | 'numbers' | 'symbols' | 'mixed'
export const TEXT_CHARSETS: readonly Charset[] = ['text', 'letters', 'numbers', 'symbols', 'mixed']

const UPPER = Object.freeze(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
const LOWER = Object.freeze(Array.from('abcdefghijklmnopqrstuvwxyz'))
const NUMBERS = Object.freeze(Array.from('0123456789'))
const SYMBOLS = Object.freeze(Array.from('#%&@$?!*+=<>/'))
const MIXED_UPPER = Object.freeze([...UPPER, ...NUMBERS, ...SYMBOLS])
const MIXED_LOWER = Object.freeze([...LOWER, ...NUMBERS, ...SYMBOLS])

const SPACE = /\s/u
/** Whether the real character is LOWERCASE — i.e. cased, and not already its own uppercase.
 *  A digit or a symbol is neither, and takes the uppercase pool. */
const isLower = (real: string) => typeof real === 'string' && real !== '' && real !== real.toUpperCase()

/** The pool `set` draws from when standing in for `real`. Every set but `text` is a shared
 *  frozen constant, so asking again costs nothing; `text` walks the cells. */
export function charPool(set: Charset, real: string, cells: readonly { char: string }[]): readonly string[] {
  const lower = isLower(real)
  switch (set) {
    case 'numbers': return NUMBERS
    case 'symbols': return SYMBOLS
    case 'mixed': return lower ? MIXED_LOWER : MIXED_UPPER
    case 'text': {
      const seen = new Set<string>()
      for (const c of cells) { const ch = c?.char; if (ch && !SPACE.test(ch)) seen.add(ch) }
      return seen.size >= 2 ? [...seen] : lower ? LOWER : UPPER
    }
    default: return lower ? LOWER : UPPER
  }
}

/** One character of `pool` at `r` ∈ [0, 1). Out-of-range and non-finite `r` are pinned to the
 *  ends rather than reading past the array — a NaN param must never produce `undefined` where
 *  a glyph is expected. */
export function pickFrom(pool: readonly string[], r: number): string {
  if (pool.length === 0) return ''
  const i = Math.floor((Number.isFinite(r) ? r : 0) * pool.length)
  return pool[i < 0 ? 0 : i >= pool.length ? pool.length - 1 : i]!
}

/** `pickFrom(charPool(…))`. It may hand back `real` itself by chance — that is a legitimate
 *  frame of a scramble, not a bug. */
export function pickChar(set: Charset, real: string, cells: readonly { char: string }[], r: number): string {
  return pickFrom(charPool(set, real, cells), r)
}

/**
 * The pool for one behaviour across one WHOLE frame, memoised in the evaluator's per-behaviour
 * scratch bag.
 *
 * A `cell` callback runs for every glyph of every frame, and `text` is the only set that has
 * to be BUILT — a walk of every cell plus a Set. It does not depend on which character it is
 * standing in for (a layer with fewer than two distinct characters has only one character, so
 * the fallback's case is the same for every cell), so it is built once per behaviour per frame
 * instead of once per glyph. Every other set returns its constant and is not cached.
 */
export function framePool(
  store: Record<string, unknown>, set: Charset, real: string, cells: readonly { char: string }[],
): readonly string[] {
  if (set !== 'text') return charPool(set, real, cells)
  const hit = store.textPool as readonly string[] | undefined
  if (hit) return hit
  const pool = charPool(set, real, cells)
  store.textPool = pool
  return pool
}
