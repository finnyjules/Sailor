// F8 · Effect-dial motion tracks. Authoring moved to the band timeline (motionx); this
// file keeps the dial enumeration and the read-only render fold for frames saved before
// 2026-09.
//
// A dial becomes a motion target addressed by the id-path
// `layers.<layerId>.effects.<effectId>.<dial>`, which `lib/studio/idPath.ts` resolves with
// ZERO change — effects carry ids (`EffectInstance`), and `effectStackOf` mints deterministic
// `fx:<type>:<ordinal>` ids for legacy layers, so a target enumerated here round-trips through
// `getByIdPath`/`setByIdPath` against a root `{ layers }`.
//
// Pure: no Vue, no canvas, no DOM. `LocalLayer` is a type-only import, so this module carries
// none of `useCompositorLayers.ts`'s composable runtime.
import { effectStackOf, EFFECT_LABELS, writeStackToLayer, type EffectInstance } from '~/lib/compositor/effectStack'
import { dialSpecsFor, type DialKind } from '~/lib/compositor/effectDials'
import { linear, easeInOutQuad } from '~/lib/motion/easing'
import { mixHex } from '~/lib/color/mix'
import { crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/** One keyframe of a dial track: a value at time `t` (seconds), easing INTO the next
 *  keyframe. `v` is a number for numeric dials, a colour string for colour dials, or a
 *  stop array for a gradient dial. */
export interface DialKeyframe {
  t: number
  v: number | string | ColorStop[]
  ease?: 'linear' | 'easeInOut'
}

/** A frame-level animation of a single effect dial, addressed by its id-path. `space`
 *  selects the colour-mix space for colour dials (default oklch); ignored for numbers. */
export interface EffectDialTrack {
  target: string
  keyframes: DialKeyframe[]
  space?: 'oklch' | 'srgb'
  /** For a GRADIENT dial: how two gradient keyframes interpolate. */
  mode?: 'crossfade' | 'travel'
  /** For a GRADIENT dial: colour-blend space (default oklab). */
  blendSpace?: 'oklab' | 'hybrid'
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

/**
 * Task 6 · Which of one effect instance's dials are driven by a motion track — the
 * pure core behind the effect inspector's "animated" (variable) signal.
 *
 * Given the layer's enumerated `targets` (from `effectDialTargets`), the open effect's
 * `effectId`, and the frame's `tracks`, returns the SET of that effect's dial KEYS
 * (`grain`, `amount`, `color`, …) that a track targets. Empty when there are no tracks,
 * or none resolve to this effect. Pure: no Vue, no lookups beyond the args — so the
 * inspector's variable-marker logic is testable without mounting the modal.
 *
 * Also accepts `bandPaths` — an iterable of timeline band paths that target dials. A dial
 * is animated when a legacy track OR a band path targets it.
 */
export function animatedDialKeysOf(
  targets: DialTargetSpec[],
  effectId: string,
  tracks: EffectDialTrack[] | undefined,
  bandPaths: Iterable<string> = [],
): Set<string> {
  const out = new Set<string>()
  const driven = new Set<string | undefined>([...(tracks ?? []).map((tr) => tr?.target), ...bandPaths])
  if (driven.size === 0) return out
  for (const spec of targets) {
    if (spec.effectId === effectId && driven.has(spec.path)) out.add(spec.dialKey)
  }
  return out
}

/** A hex colour mixHex accepts: `#` + 3, 6, or 8 hex digits (see `parseHexA`/`clampHex`
 *  in `~/lib/color/convert.ts`). Used to decide colour-mix vs. step. */
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v)
}

/** Recognises a gradient dial value: a non-empty array of `{pos:number,color:string}`
 *  stops. Used to route `evaluateDialTrack` to the gradient-interpolation branch. */
export function isGradientValue(v: unknown): v is ColorStop[] {
  return Array.isArray(v) && v.length > 0 &&
    v.every((s) => s && typeof (s as any).pos === 'number' && typeof (s as any).color === 'string')
}

/**
 * Evaluate one effect-dial track at absolute frame-time `t` (seconds).
 *
 * Mirrors `evaluateKeyframes` (evaluate.ts) EXACTLY — sort a copy by `t`, clamp before the
 * first keyframe to the first value and after the last to the last value, find the bracket
 * whose upper keyframe is the first with `kf.t >= t`, and ease INTO the next keyframe using
 * the FROM keyframe's `ease` (default `easeInOut`, i.e. `easeInOutQuad`) — so a dial animates
 * identically to a whole-layer keyframe.
 *
 * - Empty / missing keyframes → `undefined` (the fold leaves the dial untouched; never NaN).
 * - Both bracket values numbers → linear interpolation of the numbers by the eased fraction.
 * - Both bracket values hex colours → `mixHex(from, to, p, track.space ?? 'oklch')`, which
 *   returns the exact endpoint at p===0 / p===1.
 * - Otherwise (mismatched types, or a non-hex string) → STEP: the FROM keyframe's value,
 *   unchanged. This covers any future enum/bool dial with no special-casing.
 *
 * Pure interpolator: integer/count dials are NOT rounded here — the passes that need integers
 * round internally (e.g. posterise rounds `levels`), so the animated ramp stays smooth and a
 * single rounding site owns the quantisation.
 */
export function evaluateDialTrack(track: EffectDialTrack, t: number): number | string | ColorStop[] | undefined {
  const kfs = track.keyframes
  if (!kfs || !kfs.length) return undefined
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  // `sorted` is non-empty and the clamps below run before the bracket search, so every
  // index access here is in-bounds; the `!`s mirror evaluate.ts's proven idiom under
  // `noUncheckedIndexedAccess`.
  const first = sorted[0]!
  if (t <= first.t) return first.v
  const last = sorted[sorted.length - 1]!
  if (t >= last.t) return last.v
  let lo = first, hi = sorted[1]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t >= t) { lo = sorted[i - 1]!; hi = sorted[i]!; break }
  }
  const span = Math.max(1e-6, hi.t - lo.t)
  const easeFn = (lo.ease ?? 'easeInOut') === 'linear' ? linear : easeInOutQuad
  const p = easeFn((t - lo.t) / span)
  if (isGradientValue(lo.v) && isGradientValue(hi.v)) {
    const space = track.blendSpace ?? 'oklab'
    return (track.mode ?? 'crossfade') === 'travel'
      ? travelStops(lo.v, hi.v, p, space)
      : crossfadeStops(lo.v, hi.v, p, space)
  }
  if (typeof lo.v === 'number' && typeof hi.v === 'number') {
    return lo.v + (hi.v - lo.v) * p
  }
  if (isHex(lo.v) && isHex(hi.v)) {
    // `EffectDialTrack.space` is 'oklch' | 'srgb'; `mixHex` names the RGB space 'rgb'.
    return mixHex(lo.v, hi.v, p, (track.space ?? 'oklch') === 'srgb' ? 'rgb' : 'oklch')
  }
  // Mismatched types or a non-hex string: hold the FROM value (step).
  return lo.v
}

/** One track pre-parsed to the effect + dial it drives (the layer key is the Map key). */
interface ParsedTrack { effectId: string; dialKey: string; track: EffectDialTrack }

/**
 * Task 3 · The pure fold — apply effect-dial motion tracks to a layer array at frame-time `t`.
 *
 * BYTE-IDENTITY SEAM. Returns the SAME `layers` reference when there are no tracks, no clock,
 * no target resolves, or every resolved value already equals the current dial. The painter
 * reassigns its `localLayers`/`items` ONLY when the reference differs, so an absent/idle track
 * list leaves the whole draw untouched → byte-identical output.
 *
 * Why an UNCHANGED value also renders identically: the painter reads every layer's effects
 * through `effectStackOf`. A cloned layer's `.effects` IS the materialized id-stamped stack
 * with the legacy `tornEdge`/`feather` fields folded in and cleared (`writeStackToLayer`
 * shape), so `effectStackOf(clone)` returns the identical sorted/visible list — same pixels
 * for an unchanged dial. Clearing the legacy fields is MANDATORY: leaving them live would make
 * `effectStackOf(clone)` re-append (double) the torn edge / feather that `.effects` now holds.
 *
 * Purity: no Vue, no canvas, no mutation of the input — a touched layer is a fresh clone, its
 * effects are fresh clones, and every untouched layer is returned by identity.
 */
export function applyEffectDialTracks(
  layers: LocalLayer[],
  tracks: EffectDialTrack[] | undefined,
  t: number | undefined,
): LocalLayer[] {
  // The byte-identity short-circuit: nothing to fold ⇒ the exact same array reference.
  if (!tracks || tracks.length === 0 || t == null) return layers

  // Group tracks by the layer they target, parsing `layers.<layerId>.effects.<effectId>.<dial>`.
  // A malformed or foreign target is skipped, never thrown on.
  const byLayer = new Map<string, ParsedTrack[]>()
  for (const track of tracks) {
    const segs = track?.target?.split('.') ?? []
    if (segs.length !== 5 || segs[0] !== 'layers' || segs[2] !== 'effects') continue
    const [, layerId, , effectId, dialKey] = segs as [string, string, string, string, string]
    const entry: ParsedTrack = { effectId, dialKey, track }
    const list = byLayer.get(layerId)
    if (list) list.push(entry)
    else byLayer.set(layerId, [entry])
  }
  if (byLayer.size === 0) return layers

  let anyLayerCloned = false
  const next = layers.map((layer) => {
    const layerTracks = byLayer.get(layer.id)
    if (!layerTracks) return layer // untouched layer → same object reference

    // Materialize the id-stamped stack EXACTLY as the painter reads it, so a legacy layer's
    // deterministic `fx:<type>:<ordinal>` ids (and its folded torn_edge/feather) resolve.
    const stack = effectStackOf(layer)
    let anyEffectChanged = false
    const nextStack = stack.map((eff) => {
      let nextEff = eff
      for (const { effectId, dialKey, track } of layerTracks) {
        if (effectId !== eff.id) continue
        const v = evaluateDialTrack(track, t)
        if (v === undefined) continue
        if ((nextEff as unknown as Record<string, unknown>)[dialKey] === v) continue
        nextEff = { ...nextEff, [dialKey]: v } as EffectInstance
        anyEffectChanged = true
      }
      return nextEff
    })
    if (!anyEffectChanged) return layer // resolved but no value differed → same object reference
    anyLayerCloned = true
    // `writeStackToLayer` clears the legacy fields (see the doc above): `.effects` now carries
    // the folded torn_edge/feather, so leaving them live would double them under `effectStackOf`.
    return { ...layer, ...writeStackToLayer(nextStack) } as LocalLayer
  })

  return anyLayerCloned ? next : layers
}
