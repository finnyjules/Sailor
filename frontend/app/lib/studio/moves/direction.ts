// frontend/app/lib/studio/moves/direction.ts
/**
 * Reading and flipping the "in"/"out" direction of a paired preset id
 * (e.g. `fade-in` / `fade-out`). Studio-agnostic — NOTHING here may import
 * from lib/vectortype; a studio adapter builds its own `PresetPairs` via
 * `buildPairs` from its own `{ inId: outId }` map.
 *
 * `PresetPairs` is symmetric — it maps an in-id to its out-id AND the
 * out-id back to its in-id — so from the map alone you cannot tell which
 * side of a pair an id is on. `moveDirection` breaks that tie with the
 * `-in`/`In` suffix convention MOST preset ids in this codebase follow
 * (`fade-in` → `in`, `fade-out` → `out` because its pair, `fade-in`, is
 * the one with the suffix); as a fallback for a pair where neither id (or
 * both) carry the suffix, the lexically smaller id is treated as "in" —
 * arbitrary but deterministic. This is a BEST-EFFORT heuristic, not an
 * authoritative source: real Vector Type preset pairs break it outright
 * (`slide-up`/`slide-out-up` — neither carries `-in`, so the lexical
 * fallback guesses backwards; `grow-in`/`shrink-in` — both textually end
 * in `-in`, so both resolve to 'in' and 'out' is unreachable). A caller
 * that has the one-directional `{ inId: outId }` source map — i.e. every
 * real call site — MUST use `buildPairs(...).direction`/`.flip` instead,
 * which read the authoritative map rather than guessing from the id text.
 * `moveDirection`/`flipDirection` stay exported only for a caller that has
 * nothing but a bare, already-symmetric `PresetPairs` map.
 */

export type PresetPairs = Record<string, string>

const IN_SUFFIX = /-in$|In$/

/**
 * BEST-EFFORT: `presetId` is 'in' if it (or, failing that, its pair) carries
 * the in-suffix; 'out' otherwise. `null` if `presetId` isn't in `pairs` at
 * all. Guesses from id text alone and gets real preset pairs wrong (see
 * module doc) — prefer `buildPairs(...).direction` when the one-directional
 * source map is available.
 */
export function moveDirection(presetId: string, pairs: PresetPairs): 'in' | 'out' | null {
  if (!(presetId in pairs)) return null
  if (IN_SUFFIX.test(presetId)) return 'in'
  const other = pairs[presetId] as string
  if (IN_SUFFIX.test(other)) return 'out'
  return presetId < other ? 'in' : 'out'
}

/** `presetId`'s opposite-direction id, or `presetId` itself when it has no pair. */
export function flipDirection(presetId: string, pairs: PresetPairs): string {
  return pairs[presetId] ?? presetId
}

/**
 * Builds a symmetric `PresetPairs` map from a studio adapter's one-directional
 * `{ inId: outId }` declaration, plus bound `direction`/`flip` helpers that
 * read that same one-directional map directly — NOT the `-in`/`In` suffix
 * heuristic above — so they classify every pair correctly regardless of id
 * text.
 */
export function buildPairs(inToOut: Record<string, string>): {
  pairs: PresetPairs
  direction(id: string): 'in' | 'out' | null
  flip(id: string): string
} {
  const outToIn: Record<string, string> = {}
  for (const [inId, outId] of Object.entries(inToOut)) outToIn[outId] = inId

  const INSET = new Set(Object.keys(inToOut))
  const OUTSET = new Set(Object.keys(outToIn))

  const pairs: PresetPairs = { ...inToOut, ...outToIn }

  return {
    pairs,
    direction: (id: string) => (INSET.has(id) ? 'in' : OUTSET.has(id) ? 'out' : null),
    flip: (id: string) => inToOut[id] ?? outToIn[id] ?? id,
  }
}
