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
 * `-in`/`In` suffix convention every preset id in this codebase follows
 * (`fade-in` → `in`, `fade-out` → `out` because its pair, `fade-in`, is
 * the one with the suffix); as a fallback for a pair where neither id (or
 * both) carry the suffix, the lexically smaller id is treated as "in" —
 * arbitrary but deterministic, and never exercised by the current preset
 * catalog.
 */

export type PresetPairs = Record<string, string>

const IN_SUFFIX = /-in$|In$/

/** `presetId` is 'in' if it (or, failing that, its pair) carries the in-suffix; 'out' otherwise. `null` if `presetId` isn't in `pairs` at all. */
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
 * `{ inId: outId }` declaration, plus bound `direction`/`flip` helpers over it.
 */
export function buildPairs(inToOut: Record<string, string>): {
  pairs: PresetPairs
  direction(id: string): 'in' | 'out' | null
  flip(id: string): string
} {
  const pairs: PresetPairs = {}
  for (const [inId, outId] of Object.entries(inToOut)) {
    pairs[inId] = outId
    pairs[outId] = inId
  }
  return {
    pairs,
    direction: (id: string) => moveDirection(id, pairs),
    flip: (id: string) => flipDirection(id, pairs),
  }
}
