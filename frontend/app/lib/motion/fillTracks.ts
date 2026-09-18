// Layer-level FILL motion — the parallel fold for `layers.<id>.fill.phase` targets that
// `applyEffectDialTracks` deliberately rejects (it only accepts 5-segment `effects` paths).
// Pure: no Vue/DOM. Preserves the byte-identity seam (same array reference when idle).
import type { EffectDialTrack, DialTargetSpec } from '~/lib/motion/effectTracks'
import { evaluateDialTrack, isGradientValue } from '~/lib/motion/effectTracks'
import { isGradient, type Paint } from '~/lib/compositor/paint'
import { withScrolledStops, withGradientStops } from '~/lib/compositor/gradientPaint'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/**
 * The layer's fill dial targets — for a gradient fill (`isGradient`), the `fill.phase` Scroll
 * spec AND a `fill` Gradient spec (crossfade/travel between keyframed stop lists); else none.
 * Mirrors `effectDialTargets`'s shape so the Motion-tab picker can concatenate both lists with
 * no special-casing.
 */
export function fillDialTargets(layer: LocalLayer): DialTargetSpec[] {
  const fill = (layer as unknown as { fill?: Paint }).fill
  if (!isGradient(fill)) return []
  return [
    {
      path: `layers.${layer.id}.fill.phase`,
      label: 'Fill · Scroll',
      kind: 'number',
      min: 0,
      max: 1,
      effectId: '',
      dialKey: 'phase',
    },
    {
      path: `layers.${layer.id}.fill`,
      label: 'Fill · Gradient',
      kind: 'gradient',
      effectId: '',
      dialKey: 'fill',
    },
  ]
}

/**
 * The pure fold for `layers.<id>.fill.phase` and `layers.<id>.fill` tracks — apply the
 * evaluated scroll phase (via `withScrolledStops`) or the evaluated stop list (via
 * `withGradientStops`) to each targeted layer's gradient fill.
 *
 * BYTE-IDENTITY SEAM. Returns the SAME `layers` reference when there are no tracks, no clock,
 * no target resolves, or the target layer's fill isn't a gradient. A touched layer is a fresh
 * clone with a fresh `fill`; every untouched layer is returned by identity. Purity: no Vue,
 * no canvas, no mutation of the input.
 */
export function applyFillTracks(
  layers: LocalLayer[],
  tracks: EffectDialTrack[] | undefined,
  t: number | undefined,
): LocalLayer[] {
  if (!tracks || tracks.length === 0 || t == null) return layers
  // layerId -> phase track (`layers.<id>.fill.phase`, 4 segments) and
  // layerId -> gradient track (`layers.<id>.fill`, 3 segments).
  const phaseByLayer = new Map<string, EffectDialTrack>()
  const gradientByLayer = new Map<string, EffectDialTrack>()
  for (const track of tracks) {
    const segs = track?.target?.split('.') ?? []
    if (segs.length === 4 && segs[0] === 'layers' && segs[2] === 'fill' && segs[3] === 'phase') {
      phaseByLayer.set(segs[1]!, track)
    } else if (segs.length === 3 && segs[0] === 'layers' && segs[2] === 'fill') {
      gradientByLayer.set(segs[1]!, track)
    }
  }
  if (phaseByLayer.size === 0 && gradientByLayer.size === 0) return layers

  let cloned = false
  const next = layers.map((layer) => {
    const phaseTrack = phaseByLayer.get(layer.id)
    const gradientTrack = gradientByLayer.get(layer.id)
    if (!phaseTrack && !gradientTrack) return layer
    const fill = (layer as unknown as { fill?: Paint }).fill
    if (!isGradient(fill)) return layer

    let nextFill = fill
    if (phaseTrack) {
      const phase = evaluateDialTrack(phaseTrack, t)
      if (typeof phase === 'number') nextFill = withScrolledStops(nextFill, phase)
    }
    if (gradientTrack) {
      const stops = evaluateDialTrack(gradientTrack, t)
      if (isGradientValue(stops)) nextFill = withGradientStops(nextFill, stops)
    }
    if (nextFill === fill) return layer
    cloned = true
    return { ...layer, fill: nextFill } as LocalLayer
  })
  return cloned ? next : layers
}

/** Compatibility alias — `applyFillTracks` supersedes `applyFillPhaseTracks`. */
export const applyFillPhaseTracks = applyFillTracks
