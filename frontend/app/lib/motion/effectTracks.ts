// F8 · Effect-dial motion tracks — the types, and (Task 1) the enumeration of a layer's
// animatable dial targets. The evaluator (Task 2) and the fold + painter seam (Task 3)
// land here too; their signatures are sketched in the trailing comment so the next agent
// drops them in without re-deriving the shape.
//
// A dial becomes a motion target addressed by the id-path
// `layers.<layerId>.effects.<effectId>.<dial>`, which `lib/studio/idPath.ts` resolves with
// ZERO change — effects carry ids (`EffectInstance`), and `effectStackOf` mints deterministic
// `fx:<type>:<ordinal>` ids for legacy layers, so a target enumerated here round-trips through
// `getByIdPath`/`setByIdPath` against a root `{ layers }`.
//
// Pure: no Vue, no canvas, no DOM. `LocalLayer` is a type-only import, so this module carries
// none of `useCompositorLayers.ts`'s composable runtime.
import { effectStackOf, EFFECT_LABELS } from '~/lib/compositor/effectStack'
import { dialSpecsFor, type DialKind } from '~/lib/compositor/effectDials'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/** One keyframe of a dial track: a value at time `t` (seconds), easing INTO the next
 *  keyframe. `v` is a number for numeric dials, a colour string for colour dials. */
export interface DialKeyframe {
  t: number
  v: number | string
  ease?: 'linear' | 'easeInOut'
}

/** A frame-level animation of a single effect dial, addressed by its id-path. `space`
 *  selects the colour-mix space for colour dials (default oklch); ignored for numbers. */
export interface EffectDialTrack {
  target: string
  keyframes: DialKeyframe[]
  space?: 'oklch' | 'srgb'
}

/** One animatable dial of one effect instance on a layer — what the Motion-tab picker and
 *  the timeline list. `path` is the id-path a track targets; `kind`/`min`/`max` come from the
 *  schema; `effectId`/`dialKey` are carried so a UI need not re-parse the path. */
export interface DialTargetSpec {
  path: string
  label: string
  kind: DialKind
  min?: number
  max?: number
  effectId: string
  dialKey: string
}

/**
 * Every animatable dial on this layer's effects, in stack order.
 *
 * Walks `effectStackOf(layer)` — so it works identically for a new-shape layer (effects
 * carry stored ids) and a legacy layer (deterministic `fx:<type>:<ordinal>` ids minted on
 * read) — and, per effect instance, emits one `DialTargetSpec` for each dial the schema
 * lists. The `path` is built from the SAME id-stamped stack the fold will write against, so
 * it resolves back to the live dial value with no change to `idPath.ts`.
 */
export function effectDialTargets(layer: LocalLayer): DialTargetSpec[] {
  const out: DialTargetSpec[] = []
  for (const fx of effectStackOf(layer)) {
    for (const spec of dialSpecsFor(fx.type)) {
      out.push({
        path: `layers.${layer.id}.effects.${fx.id}.${spec.key}`,
        label: `${EFFECT_LABELS[fx.type]} · ${spec.label}`,
        kind: spec.kind,
        min: spec.min,
        max: spec.max,
        effectId: fx.id,
        dialKey: spec.key,
      })
    }
  }
  return out
}

// Task 2 · evaluateDialTrack(track: EffectDialTrack, t: number): number | string | undefined
//   Numeric lerp via `~/lib/motion/easing.ts` (linear / easeInOut), matching evaluate.ts's
//   seconds-based ease-into-NEXT idiom; colour mix via `mixHex` (~/lib/color/mix.ts) when both
//   bracketing values are hex; step (nearest earlier keyframe) for enum/bool; clamp
//   before-first / after-last; empty or malformed → undefined (never NaN).
//
// Task 3 · applyEffectDialTracks(layers: LocalLayer[], tracks: EffectDialTrack[] | undefined,
//                                t: number): LocalLayer[]
//   The pure fold: clone only touched layers + their id-stamped `.effects`, `setByIdPath`
//   (~/lib/studio/idPath.ts) the evaluated value against a root `{ layers }`, and return the
//   SAME reference when `tracks`/`t` are absent or nothing resolves (the byte-identity seam).
//   Wired into `paintLayerStack` (useCompositorLayers.ts) at the top; local items rebuilt by id.
