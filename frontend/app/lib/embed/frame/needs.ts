/**
 * Fix round 2 (R14a, second half): the ONE bundle-safe module that says whether a Frame's layers
 * carry a paper.js-backed geometry effect (`boolean`/`shatter`/`morph`) — no DOM, no Vue, no
 * network, nothing here does anything but read plain data. `gather.ts`'s `computeNeedsOutlines`
 * (plan-time, decides which bundle to fetch) and `surfaces/frame.ts`'s `mount()` (adapter-time,
 * defence in depth) both import THIS function rather than each keeping their own copy of the
 * check, so the two can never quietly drift apart.
 *
 * WHY the adapter needs its own copy of the predicate, not just `FrameSnapshot.needsOutlines`:
 * fix round 1 made `mount()` await `warmPaperBoolean()` before its first paint whenever
 * `snap.needsOutlines` is true — but that still trusts the SNAPSHOT'S OWN precomputed flag. If
 * `computeNeedsOutlines` itself ever under-counts (a bug in ITS logic, not in `bundleNameFor`'s
 * consumption of it — R14e already hardened that half), `needsOutlines` would be `false`, the
 * gatherer would ship `frame-lean.js`, and `mount()`'s `if (snap.needsOutlines)` gate would never
 * even run — `warmPaperBoolean` never called, `paperLean.embed.ts`'s throwing stand-in never
 * touched, and the first paint would silently ship the geometry effect's cold, unclipped
 * pass-through shape. Calling THIS function directly on the live `variant.layers` the adapter
 * already has, instead of trusting the snapshot's derived flag, closes that gap: even a
 * completely wrong `needsOutlines` cannot suppress the warm-gate, because the gate no longer
 * depends on it.
 */
import { effectStackOf, isGeometryKind, type EffectKind } from '~/lib/compositor/effectStack'

/** The three F3 geometry kinds that read paper.js — `boolean`/`shatter` directly
 *  (booleanGeometry.ts), `morph` (blendPath, ~/lib/vector/morph.ts) grouped in per Task 10's
 *  brief even though it is pure JS today (see gather.ts's computeNeedsOutlines doc for why). */
const PAPER_GEOMETRY_KINDS = new Set<EffectKind>(['boolean', 'shatter', 'morph'])

/**
 * True when ANY of `layers` carries a `boolean`/`shatter`/`morph` effect — regardless of that
 * effect's `visible` flag (R14f: a stored `visible: false` is not trustworthy — see
 * gather.ts's computeNeedsOutlines doc for the full trace of why motion can revive it). Takes a
 * bare layer array (not a typed `LocalLayer[]`/`FrameVariant`) so this module needs no import,
 * type-only or otherwise, of anything Vue/DOM-adjacent — `effectStackOf`'s own parameter type
 * already accepts `unknown`-shaped input via its own cast, which every existing caller
 * (plan.ts, gather.ts) already relies on the same way.
 */
export function layersNeedPaper(layers: readonly unknown[]): boolean {
  for (const l of layers) {
    for (const e of effectStackOf(l as Parameters<typeof effectStackOf>[0])) {
      if (isGeometryKind(e.type) && PAPER_GEOMETRY_KINDS.has(e.type)) return true
    }
  }
  return false
}
