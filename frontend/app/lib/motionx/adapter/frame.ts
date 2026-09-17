// Frame adapter — the ONE intentionally compositor-coupled file in the motionx package.
// Applies a resolved motionx property value onto a cloned Frame/Compositor layer. The
// motionx core stays pure (no compositor imports); only this file bridges the two.
import { evaluateTracks, type PropertyValue, type Track } from '~/lib/motionx'
import type { GradientStop as ColorStop } from '~/lib/color/harmony'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isGradient, type Paint } from '~/lib/compositor/paint'
import { withScrolledStops, withGradientStops } from '~/lib/compositor/gradientPaint'
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
