// Frame adapter — the ONE intentionally compositor-coupled file in the motionx package.
// Applies a resolved motionx property value onto a cloned Frame/Compositor layer. The
// motionx core stays pure (no compositor imports); only this file bridges the two.
import { compileBehaviour, evaluateTracks, pickTrack, evaluateTrack, type Behaviour, type BehaviourTarget, type PropertyValue, type StoredBehaviour, type Track } from '~/lib/motionx'
// The index, not `./evaluate` — importing it is what REGISTERS the four letter behaviour
// kinds, and this file is on the only path the painter reaches them by.
import { isTextBehaviour, textCanMove } from '~/lib/motionx/text'
import { revealParams, type MotionReveal } from '~/lib/motionx/reveal'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isGradient, type Paint } from '~/lib/compositor/paint'
import { withScrolledStops, withGradientStops, paintStopsToColor } from '~/lib/compositor/gradientPaint'
import { effectStackOf, writeStackToLayer, EFFECT_LABELS } from '~/lib/compositor/effectStack'
import { dialSpecsFor } from '~/lib/compositor/effectDials'

const TRANSFORM = new Set(['x', 'y', 'rotation', 'scale', 'opacity'])

/** Returns a NEW layer with `prop` set to `value`. Unknown/inapplicable prop → the
 *  input layer unchanged (same ref), so callers can cheaply detect a no-op. */
export function applyResolvedValue(layer: LocalLayer, prop: string, value: PropertyValue): LocalLayer {
  if (TRANSFORM.has(prop) && typeof value === 'number') {
    // Only path/image layers have a native `scale` the painter reads. Everything else gets a
    // transient `motionScale` that paintLayerStack applies as a draw-time scale about the
    // layer centre (what the old motion engine did). Clones only — never persisted.
    if (prop === 'scale' && typeof (layer as unknown as { scale?: unknown }).scale !== 'number') {
      return { ...layer, motionScale: value } as unknown as LocalLayer
    }
    return { ...layer, [prop]: value } as LocalLayer
  }
  const fill = (layer as unknown as { fill?: Paint }).fill
  if (prop === 'fill.phase' && typeof value === 'number' && isGradient(fill)) {
    return { ...layer, fill: withScrolledStops(fill, value) } as LocalLayer
  }
  if (prop === 'fill' && Array.isArray(value) && isGradient(fill)) {
    return { ...layer, fill: withGradientStops(fill, value as ColorStop[]) } as LocalLayer
  }
  const eff = prop.match(/^effects\.([^.]+)\.(.+)$/)
  if (eff) {
    const [, effectId, dial] = eff as unknown as [string, string, string]
    const stack = effectStackOf(layer)
    let changed = false
    const next = stack.map((e) => (e.id === effectId ? (changed = true, { ...e, [dial]: value }) : e))
    if (!changed) return layer
    return { ...layer, ...writeStackToLayer(next) } as LocalLayer
  }
  return layer
}

/** Evaluate all `tracks` at `t` and fold the resolved values onto cloned `layers`.
 *  Track paths are `layers.<id>.<prop>`; multiple props for the same layer fold onto
 *  a single clone. Returns the SAME array reference when idle (no tracks, no time,
 *  or nothing resolves/changes); non-targeted layers are returned by identity. */
export function applyMotionxTracks(layers: LocalLayer[], tracks: Track[] | undefined, t: number | undefined): LocalLayer[] {
  if (!tracks || tracks.length === 0 || t == null) return layers
  const resolved = evaluateTracks(tracks, t)
  if (resolved.size === 0) return layers
  const byLayer = new Map<string, Array<[string, PropertyValue]>>()
  for (const [path, value] of resolved) {
    const m = path.match(/^layers\.([^.]+)\.(.+)$/)
    if (!m) continue
    const [, layerId, prop] = m as unknown as [string, string, string]
    const list = byLayer.get(layerId)
    if (list) list.push([prop, value]); else byLayer.set(layerId, [[prop, value]])
  }
  if (byLayer.size === 0) return layers
  let changed = false
  const next = layers.map((layer) => {
    const props = byLayer.get(layer.id)
    if (!props) return layer
    let l = layer
    for (const [prop, value] of props) l = applyResolvedValue(l, prop, value)
    if (l !== layer) changed = true
    return l
  })
  return changed ? next : layers
}

/** A text layer's letter behaviours plus the clock to draw them at, parked on a CLONE for
 *  one frame. Same contract as `motionScale`: transient, never persisted, read by the text
 *  draw and by nothing else. */
export interface TextMotion { behaviours: StoredBehaviour[]; t: number }

/**
 * Fold letter behaviours onto the layers for this frame.
 *
 * Unlike a track, a letter behaviour has nothing to resolve to a property VALUE — it moves
 * the glyphs inside a layer, which only the text draw can do. So the fold's whole job is to
 * hand the painter the behaviours and the clock, on a clone of each text layer they target.
 *
 * Returns the SAME array reference whenever there is nothing to attach (no clock, no
 * `text.*` behaviour, none of them targeting a text layer in `layers`), so a frame without
 * letter behaviours never even allocates — and, downstream, never leaves the byte-identical
 * static draw. Non-targeted layers come back by identity. A `text.*` behaviour aimed at a
 * non-text layer is ignored rather than attached: nothing would read it.
 *
 * A layer is ALSO left alone at instants when none of its own bars can move a letter
 * (`textCanMove`) — an entrance that finished at t = 0.8 must not cost the rest of the clip
 * a per-glyph redraw, nor keep the layer out of the silhouette raster cache, which skips
 * anything carrying `textMotion`.
 */
export function applyTextBehaviours(
  layers: LocalLayer[], behaviours: StoredBehaviour[] | undefined, t: number | undefined,
): LocalLayer[] {
  if (!behaviours || behaviours.length === 0 || t == null) return layers
  const byLayer = new Map<string, StoredBehaviour[]>()
  for (const b of behaviours) {
    if (!isTextBehaviour(b)) continue
    const list = byLayer.get(b.layerId)
    if (list) list.push(b); else byLayer.set(b.layerId, [b])
  }
  if (byLayer.size === 0) return layers
  let changed = false
  const next = layers.map((layer) => {
    if (layer.kind !== 'text') return layer
    const own = byLayer.get(layer.id)
    if (!own || !textCanMove(own, t)) return layer
    changed = true
    return { ...layer, textMotion: { behaviours: own, t } as TextMotion } as unknown as LocalLayer
  })
  return changed ? next : layers
}

/** Properties a behaviour can drive that are NOT layer properties — never offered in Add
 *  property, but they still get a timeline row, which needs a name. */
export const MOTION_ONLY_LABELS: Record<string, string> = { reveal: 'Reveal' }

const startOfBar = (tr: Track) => (tr.keyframes.length ? Math.min(...tr.keyframes.map((k) => k.t)) : 0)

/**
 * Fold reveal transitions (dither) onto the layers for this frame.
 *
 * The bar's TRACK carries only the amount; the look lives on the bar. So for every layer with
 * a tagged `reveal` track, find the track that WINS at `t` (the same rule `evaluateTracks`
 * uses), read its bar's dials, and park `motionReveal` on a clone:
 *   amount ≥ 1 → nothing at all (layer by identity — a finished entrance costs nothing);
 *   amount ≤ 0 → a note with amount 0 (the painter skips the layer);
 *   between    → the note the painter draws through.
 * Same-reference return whenever nothing is attached. An UNTAGGED `reveal` band has no bar
 * and therefore no look: ignored.
 */
export function applyRevealBehaviours(
  layers: LocalLayer[], tracks: Track[] | undefined, behaviours: StoredBehaviour[] | undefined, t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || !behaviours || behaviours.length === 0 || t == null) return layers
  const byLayer = new Map<string, Track[]>()
  for (const tr of tracks) {
    if (!tr.behaviourId) continue
    const m = tr.path.match(/^layers\.([^.]+)\.reveal$/)
    if (!m) continue
    const list = byLayer.get(m[1]!)
    if (list) list.push(tr); else byLayer.set(m[1]!, [tr])
  }
  if (byLayer.size === 0) return layers
  let changed = false
  const next = layers.map((layer) => {
    const list = byLayer.get(layer.id)
    if (!list) return layer
    const pick = pickTrack(list, t)
    const bar = pick && behaviours.find((b) => b.id === pick.behaviourId && b.kind === 'dither')
    if (!pick || !bar) return layer
    const v = evaluateTrack(pick, t)
    const amount = typeof v === 'number' && Number.isFinite(v) ? v : 1
    if (amount >= 1) return layer
    changed = true
    const note: MotionReveal = { ...revealParams(bar.params), amount: Math.max(0, amount), elapsed: Math.max(0, t - startOfBar(pick)) }
    return { ...layer, motionReveal: note } as unknown as LocalLayer
  })
  return changed ? next : layers
}

/** Builds a BehaviourTarget over a Frame/Compositor layer: reads current values by
 *  property path so a Behaviour can compile tracks relative to where the layer already is. */
export function frameTarget(layer: LocalLayer): BehaviourTarget {
  const rec = layer as unknown as Record<string, unknown>
  const fill = rec.fill as Paint | undefined
  return {
    get(prop) {
      if (prop === 'scale' && typeof rec.scale !== 'number') return 1
      if (TRANSFORM.has(prop) && typeof rec[prop] === 'number') return rec[prop] as number
      if (prop === 'fill' && isGradient(fill)) return paintStopsToColor(fill)
      return undefined
    },
    has(prop) { return this.get(prop) !== undefined },
  }
}

export type PropertyGroup = 'Transform' | 'Fill' | 'Effects'
export interface AnimatableProperty {
  path: string
  type: 'number' | 'color' | 'gradient'
  label: string
  group: PropertyGroup
  min?: number
  max?: number
}

/** Every property a layer can be animated on, grouped for the "Add property" picker:
 *  Transform (x/y/scale/rotation/opacity), Fill (gradient + scroll phase, when the fill
 *  is a gradient), Effects (every number/colour/gradient dial of every effect in the
 *  stack, with its range; enum/bool dials are not animatable). Paths are
 *  `layers.<id>.<prop>` — exactly what the render fold applies. */
export function animatableProperties(layer: LocalLayer): AnimatableProperty[] {
  const id = layer.id
  const out: AnimatableProperty[] = [
    { path: `layers.${id}.x`, type: 'number', label: 'Position X', group: 'Transform', min: 0, max: 1 },
    { path: `layers.${id}.y`, type: 'number', label: 'Position Y', group: 'Transform', min: 0, max: 1 },
    { path: `layers.${id}.scale`, type: 'number', label: 'Scale', group: 'Transform', min: 0, max: 4 },
    { path: `layers.${id}.rotation`, type: 'number', label: 'Rotation', group: 'Transform', min: -360, max: 360 },
    { path: `layers.${id}.opacity`, type: 'number', label: 'Opacity', group: 'Transform', min: 0, max: 1 },
  ]
  const fill = (layer as unknown as { fill?: Paint }).fill
  if (isGradient(fill)) {
    out.push({ path: `layers.${id}.fill`, type: 'gradient', label: 'Fill · Gradient', group: 'Fill' })
    out.push({ path: `layers.${id}.fill.phase`, type: 'number', label: 'Fill · Scroll', group: 'Fill', min: 0, max: 1 })
  }
  for (const fx of effectStackOf(layer)) {
    for (const spec of dialSpecsFor(fx.type)) {
      if (spec.kind !== 'number' && spec.kind !== 'color' && spec.kind !== 'gradient') continue
      out.push({
        path: `layers.${id}.effects.${fx.id}.${spec.key}`,
        type: spec.kind,
        label: `${EFFECT_LABELS[fx.type]} · ${spec.label}`,
        group: 'Effects',
        min: spec.min,
        max: spec.max,
      })
    }
  }
  return out
}

/** Compile a behaviour for one layer: compiles via the core against the layer's
 *  current values, then prefixes each track path with `layers.<id>.` so the
 *  resulting tracks are ready for `applyMotionxTracks` / storage on the frame doc. */
export function compileBehaviourForLayer(layer: LocalLayer, behaviour: Behaviour): Track[] {
  const target = frameTarget(layer)
  return compileBehaviour(behaviour, target).map((tr) => ({ ...tr, path: `layers.${layer.id}.${tr.path}` }))
}
