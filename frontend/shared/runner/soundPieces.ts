/**
 * Long sounds in pieces (step 3, R11.5, ruling (h)): the arithmetic the
 * splitter (server/media/split.ts) cuts by and the price holds by, in one
 * place so the two can never disagree.
 *
 * A sound longer than one call takes is cut into pieces of at most `limit`
 * seconds. Each cut is at the quietest point of the last `window` seconds
 * before the limit — never past it — so every piece but the last is at least
 * `limit − window` long. The most pieces a sound of S seconds can make is then
 * `1 + ceil((S − limit) / (limit − window))` (`soundPieceCount`): the k-th cut
 * happens only while more than `limit` is left after the (k − 1)-th, which
 * itself is at least (k − 1)(limit − window) in. The hold prices that many
 * calls, each at most `limit` long and the last at most what is left after
 * the others' shortest (`soundPieceBounds`), so it is a TRUE upper bound of
 * what the pieces are charged, whatever the cut points turn out to be.
 *
 * Pure: no imports, so the price module and the server read the same rule.
 */

/** The seconds before each limit searched for the quietest point (the cut is never earlier than limit − window). */
export const SOUND_PIECE_WINDOW_SECONDS = 30

/**
 * The most pieces a sound of `seconds` makes, cut at most every `limit`
 * seconds and never more than `window` before it (see the header). One for a
 * sound of `limit` or less.
 */
export function soundPieceCount(seconds: number, limit: number, window = SOUND_PIECE_WINDOW_SECONDS): number {
  if (!(limit > window) || !(window >= 0)) throw new Error('A piece must be longer than the window its cut is searched in')
  if (!(seconds > limit)) return 1
  return 1 + Math.ceil((seconds - limit) / (limit - window))
}

/**
 * Each piece's longest possible length, for the hold: one piece of `seconds`
 * when it fits `single` (what one call takes where it runs), else
 * `soundPieceCount` pieces, all of `limit` but the last, which is at most
 * what is left once the others are at their shortest (limit − window).
 * Summed, never below `seconds`; each price per piece is never below that
 * piece's real price (a price that grows with the seconds).
 */
export function soundPieceBounds(seconds: number, single: number, limit: number, window = SOUND_PIECE_WINDOW_SECONDS): number[] {
  if (!(seconds > single)) return [Math.max(0, seconds)]
  const n = soundPieceCount(seconds, limit, window)
  if (n === 1) return [seconds]
  const last = Math.min(limit, seconds - (n - 1) * (limit - window))
  return [...Array.from({ length: n - 1 }, () => limit), Math.max(0, last)]
}

/**
 * The cut points of a sound of `total` samples (each a sample index where a
 * piece starts, after the first at 0), cut at most every `limit` samples:
 * from each piece's start, the quietest block whose start lies in
 * [start + limit − window, start + limit − block] (`quiet[b]`: block b's
 * loudness, blocks of `block` samples from 0; the latest of equals), cut at
 * that block's middle. Never past the limit, never earlier than the window;
 * so never more pieces than `soundPieceCount` gives for the same numbers.
 */
export function quietestCuts(quiet: ArrayLike<number>, o: { total: number; block: number; limit: number; window: number }): number[] {
  const { total, block, limit, window } = o
  if (!(Number.isInteger(block) && block > 0 && Number.isInteger(limit) && Number.isInteger(window) && limit > window && window >= block)) {
    throw new Error('The cut needs whole sample counts, a window of at least one block and a piece longer than the window')
  }
  const cuts: number[] = []
  let start = 0
  while (total - start > limit) {
    const from = Math.ceil((start + limit - window) / block)
    const to = Math.floor((start + limit - block) / block)
    let best = -1
    let bestLoud = Number.POSITIVE_INFINITY
    for (let b = from; b <= to && b < quiet.length; b++) {
      const loud = quiet[b]!
      if (loud <= bestLoud) { best = b; bestLoud = loud }
    }
    // No whole block in the window (or no loudness read there): cut at the limit itself.
    const cut = best < 0 ? start + limit : best * block + Math.floor(block / 2)
    cuts.push(cut)
    start = cut
  }
  return cuts
}
