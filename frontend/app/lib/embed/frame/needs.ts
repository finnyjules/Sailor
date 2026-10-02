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
import { isTipStroke } from '~/lib/brushTips/record'
import { isFoilFill } from '~/lib/compositor/paint'
import { isLightBandPath } from '~/lib/frame/lighting/bandPaths'
import { strokeStackOf } from '~/lib/compositor/strokeStack'

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

/**
 * Light layers final review: the features `frame-lean.js` does not carry (vite.embed.config.ts
 * stubs them in that one build, to keep it under its size ceiling) — brush tips (a paint layer
 * with a tip stroke), Pixel reveal (a `pixelreveal` motion bar, muted or not), Morph (a `morph`
 * motion bar — the `morph` geometry effect already goes full through `layersNeedPaper`) and Relight (a
 * `relight` effect, any visibility, same R14f posture as `layersNeedPaper`). Returns the first
 * one found, or null. `gather.ts` folds a non-null answer into `needsOutlines` so the export
 * fetches the full `frame.js`; `surfaces/frame.ts`'s `mount()` re-asks on the live layers and
 * rejects a lean mount that would need one (the poster stays) rather than draw it wrong.
 */
export function frameNeedsFullBundle(
  layers: readonly unknown[],
  behaviours?: ReadonlyArray<{ kind?: unknown }> | null,
  motionx?: ReadonlyArray<{ path?: unknown; muted?: unknown }> | null,
): 'Animated lights' | 'brush tips' | 'Pixel reveal' | 'Relight' | 'Morph' | 'Print finishes under lights' | null {
  for (const l of layers) {
    const strokes = (l as { strokes?: unknown } | null)?.strokes
    if (Array.isArray(strokes) && strokes.some(s => isTipStroke(s as Parameters<typeof isTipStroke>[0]))) return 'brush tips'
  }
  if ((behaviours ?? []).some(b => b?.kind === 'pixelreveal')) return 'Pixel reveal'
  // Frame Morph ("Morph into" / "Shape morph into"): any `morph` bar, muted or not, any partners.
  if ((behaviours ?? []).some(b => b?.kind === 'morph')) return 'Morph'
  for (const l of layers) {
    for (const e of effectStackOf(l as Parameters<typeof effectStackOf>[0])) {
      if (e.type === 'relight') return 'Relight'
    }
  }
  if (hasVisibleLight(layers) && layers.some(layerHasPrintFinish)) return 'Print finishes under lights'
  // Light dials, Lift and Darkness on the timeline: the lean bundle has no light motion.
  if ((motionx ?? []).some(t => !t?.muted && typeof t?.path === 'string' && isLightBandPath(t.path))) return 'Animated lights'
  return null
}

/** A visible light layer (light layers stage 3: finishes read the Frame's lights). */
function hasVisibleLight(layers: readonly unknown[]): boolean {
  return layers.some(l => (l as { kind?: unknown; visible?: unknown } | null)?.kind === 'light' && (l as { visible?: unknown }).visible !== false)
}

/** A foil paint (fill, text colour / outline, line stroke, tint, or any stroke-stack entry) or a
 *  `spot_uv` effect: the two finishes the lights relight with `finishLights.ts`, which the lean
 *  bundle stubs out. Pure data check, no painter import. */
function layerHasPrintFinish(l: unknown): boolean {
  const o = l as Record<string, unknown> | null
  if (!o) return false
  for (const k of ['fill', 'color', 'strokeColor', 'stroke', 'tint']) {
    if (isFoilFill(o[k] as Parameters<typeof isFoilFill>[0])) return true
  }
  if (strokeStackOf(o as Parameters<typeof strokeStackOf>[0]).some(st => isFoilFill(st.paint))) return true
  return effectStackOf(l as Parameters<typeof effectStackOf>[0]).some(e => e.type === 'spot_uv')
}
