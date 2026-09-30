/**
 * Which layers in the open Frame need MoGe-2 surfaces (stage 2 Task 4). Pure — no request,
 * no registry read — so CompositorModal can watch the layer tree and hand the resulting
 * refs to `requestSurfaces` without this helper knowing about Vue or the network.
 *
 * Mirrors `localDepthSource` (CompositorModal.vue): an image layer keys by its filename,
 * a wired layer keys by the `/view` URL its `depthKey` carries (via `depthSourceFromViewUrl`).
 * Anything else — text, shapes, a live wired slot with no file behind it — has no depth
 * source and is excluded, same as it is for DOF.
 */
import { effectStackOf, type StackHost } from '~/lib/compositor/effectStack'
import { depthSourceFromViewUrl, depthKey, type DepthRef } from '~/lib/compositor/depthRegistry'

export interface RelightLayerLike extends StackHost {
  kind?: string
  filename?: string
  depthKey?: string
  visible?: boolean
}

/** Same rule as `layerHidden` (useCompositorLayers.ts): visible === false is hidden,
 *  undefined means visible. Inlined rather than imported — this file stays a small, pure
 *  leaf with no edge into the composable's much larger module graph. */
const layerHidden = (l: { visible?: boolean }): boolean => l.visible === false

function depthSourceOf(l: RelightLayerLike): DepthRef | undefined {
  if (l.kind === 'image') return l.filename || undefined
  if (l.kind === 'wired') return depthSourceFromViewUrl(l.depthKey) ?? undefined
  return undefined
}

/** The depth refs of every VISIBLE layer carrying a VISIBLE Relight effect and a depth
 *  source, deduped by `depthKey` so two layers of the same photo request surfaces once.
 *  A hidden layer is excluded even with a visible Relight effect — no paint ever reads
 *  a hidden layer's content (`layerHidden` in `paintLayerStack`), so reading its surfaces
 *  would be a paid call nothing ever uses. */
export function relightSurfaceRefs(layers: readonly RelightLayerLike[] | null | undefined): DepthRef[] {
  const seen = new Map<string, DepthRef>()
  for (const l of layers ?? []) {
    if (layerHidden(l)) continue
    const relight = effectStackOf(l).find(e => e.type === 'relight')
    if (!relight || relight.visible === false) continue
    const ref = depthSourceOf(l)
    if (!ref) continue
    const key = depthKey(ref)
    if (!seen.has(key)) seen.set(key, ref)
  }
  return [...seen.values()]
}
