// Layer-level FILL motion — the parallel fold for `layers.<id>.fill.phase` targets that
// `applyEffectDialTracks` deliberately rejects (it only accepts 5-segment `effects` paths).
// Pure: no Vue/DOM. Preserves the byte-identity seam (same array reference when idle).
import type { EffectDialTrack, DialTargetSpec } from '~/lib/motion/effectTracks'
import { evaluateDialTrack } from '~/lib/motion/effectTracks'
import { isGradient, type Paint } from '~/lib/compositor/paint'
import { withScrolledStops } from '~/lib/compositor/gradientPaint'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/**
 * The layer's fill-scroll dial target — ONE `layers.<id>.fill.phase` spec when the layer's
 * fill is a `Gradient` (`isGradient`), else none. Mirrors `effectDialTargets`'s shape so the
 * Motion-tab picker can concatenate both lists with no special-casing.
 */
export function fillDialTargets(layer: LocalLayer): DialTargetSpec[] {
  const fill = (layer as unknown as { fill?: Paint }).fill
  if (!isGradient(fill)) return []
  return [{
    path: `layers.${layer.id}.fill.phase`,
    label: 'Fill · Scroll',
    kind: 'number',
    min: 0,
    max: 1,
    effectId: '',
    dialKey: 'phase',
  }]
}

/**
 * The pure fold for `layers.<id>.fill.phase` tracks — apply the evaluated scroll phase to
 * each targeted layer's gradient fill via `withScrolledStops`.
 *
 * BYTE-IDENTITY SEAM. Returns the SAME `layers` reference when there are no tracks, no clock,
 * no `fill.phase` target resolves, or the target layer's fill isn't a gradient. A touched
 * layer is a fresh clone with a fresh `fill`; every untouched layer is returned by identity.
 * Purity: no Vue, no canvas, no mutation of the input.
 */
export function applyFillPhaseTracks(
  layers: LocalLayer[],
  tracks: EffectDialTrack[] | undefined,
  t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || t == null) return layers
  // layerId -> phase track. Only `layers.<id>.fill.phase` (4 segments) is ours.
  const byLayer = new Map<string, EffectDialTrack>()
  for (const track of tracks) {
    const segs = track?.target?.split('.') ?? []
    if (segs.length === 4 && segs[0] === 'layers' && segs[2] === 'fill' && segs[3] === 'phase') {
      byLayer.set(segs[1]!, track)
    }
  }
  if (byLayer.size === 0) return layers

  let cloned = false
  const next = layers.map((layer) => {
    const track = byLayer.get(layer.id)
    if (!track) return layer
    const fill = (layer as unknown as { fill?: Paint }).fill
    if (!isGradient(fill)) return layer
    const phase = evaluateDialTrack(track, t)
    if (typeof phase !== 'number') return layer
    cloned = true
    return { ...layer, fill: withScrolledStops(fill, phase) } as LocalLayer
  })
  return cloned ? next : layers
}
