// Frame adapter — the ONE intentionally compositor-coupled file in the motionx package.
// Applies a resolved motionx property value onto a cloned Frame/Compositor layer. The
// motionx core stays pure (no compositor imports); only this file bridges the two.
import type { PropertyValue } from '~/lib/motionx'
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
