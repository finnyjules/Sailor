// Frame adapter — the ONE intentionally compositor-coupled file in the motionx package.
// Applies a resolved motionx property value onto a cloned Frame/Compositor layer. The
// motionx core stays pure (no compositor imports); only this file bridges the two.
import { evaluateTracks, type BehaviourTarget, type PropertyValue, type Track } from '~/lib/motionx'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isGradient, type Paint } from '~/lib/compositor/paint'
import { withScrolledStops, withGradientStops, paintStopsToColor } from '~/lib/compositor/gradientPaint'
import { effectStackOf, writeStackToLayer } from '~/lib/compositor/effectStack'

const TRANSFORM = new Set(['x', 'y', 'rotation', 'scale', 'opacity'])

/** Returns a NEW layer with `prop` set to `value`. Unknown/inapplicable prop → the
 *  input layer unchanged (same ref), so callers can cheaply detect a no-op. */
export function applyResolvedValue(layer: LocalLayer, prop: string, value: PropertyValue): LocalLayer {
  if (TRANSFORM.has(prop) && typeof value === 'number') {
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

/** Builds a BehaviourTarget over a Frame/Compositor layer: reads current values by
 *  property path so a Behaviour can compile tracks relative to where the layer already is. */
export function frameTarget(layer: LocalLayer): BehaviourTarget {
  const rec = layer as unknown as Record<string, unknown>
  const fill = rec.fill as Paint | undefined
  return {
    get(prop) {
      if (TRANSFORM.has(prop) && typeof rec[prop] === 'number') return rec[prop] as number
      if (prop === 'fill' && isGradient(fill)) return paintStopsToColor(fill)
      return undefined
    },
    has(prop) { return this.get(prop) !== undefined },
  }
}

/** Plain data list of the properties a layer can be animated on — transform/opacity,
 *  the fill gradient (+ its scroll phase) when the fill is a gradient, and one entry
 *  per animatable effect dial. Seed for Phase 3's picker/gallery; not itself UI. */
export function animatableProperties(layer: LocalLayer): Array<{ path: string; type: 'number' | 'color' | 'gradient'; label: string }> {
  const id = layer.id
  const out: Array<{ path: string; type: 'number' | 'color' | 'gradient'; label: string }> = [
    { path: `layers.${id}.x`, type: 'number', label: 'Position X' },
    { path: `layers.${id}.y`, type: 'number', label: 'Position Y' },
    { path: `layers.${id}.scale`, type: 'number', label: 'Scale' },
    { path: `layers.${id}.rotation`, type: 'number', label: 'Rotation' },
    { path: `layers.${id}.opacity`, type: 'number', label: 'Opacity' },
  ]
  const fill = (layer as unknown as { fill?: Paint }).fill
  if (isGradient(fill)) {
    out.push({ path: `layers.${id}.fill`, type: 'gradient', label: 'Fill · Gradient' })
    out.push({ path: `layers.${id}.fill.phase`, type: 'number', label: 'Fill · Scroll' })
  }
  for (const e of effectStackOf(layer)) {
    // Minimal: expose the gradientMap ramp; scalar dials come with the full registry in Phase 3.
    if ((e as { type?: string }).type === 'gradientMap') {
      out.push({ path: `layers.${id}.effects.${e.id}.stops`, type: 'gradient', label: 'Gradient map · Ramp' })
    }
  }
  return out
}
