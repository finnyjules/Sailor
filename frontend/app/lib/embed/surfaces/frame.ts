/**
 * The Frame as an embeddable surface. Ships the editor's own painter (paintLayerStack) unchanged;
 * everything it would fetch comes from the snapshot through the asset resolver chain
 * (~/lib/compositor/assetScope), which is registered for the life of the handle — so it also
 * covers the poster bake, which runs this adapter inside the app.
 *
 * Mount does every await: fonts, shaders and their textures, depth maps, images, clip frames and
 * the transitions' shaders. setTime is one synchronous paint. A font or shader that fails REJECTS
 * the mount — the runtime then keeps the poster, which is a correct still, never a wrong picture.
 *
 * Fit and bleed without touching the painter: the background is painted once across the whole
 * box (a paintLayerStack call with no layers, sized to the box in artboard units), then the layers
 * are painted under the fit transform with no background. Post effects already work on the whole
 * device canvas (applyStackPost), so they cover the bleed too.
 */
import type { EmbedHandle, EmbedSurface } from '../contract'
import { assetKey, type FrameSnapshot, type FrameVariant } from '../frame/types'
import { fitRect } from '../frame/fit'
import { fontFaceId, fontFaceRule } from '../fontFace'
import { registerAssetResolver } from '~/lib/compositor/assetScope'
import { addShaderFxEffects } from '~/lib/shaderfx/catalogStore'
import { whenFieldEffectReady } from '~/lib/shaderfill/field'
import { seedDepthImage } from '~/lib/compositor/depthRegistry'
import { ensureRevealShadersReady } from '~/lib/motionx/reveal/paintPixels'
import {
  paintLayerStack, ensureLayerImages, withWiredContent, type LocalLayer, type StackItem,
} from '~/composables/useCompositorLayers'
import '~/lib/motion/paint' // registers the per-layer animation painter paintLayerStack relies on

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('embed: an inlined image failed to decode'))
    im.src = src
  })
}

/** The stack the painter draws, in the Frame's saved order. Only `l:` keys exist in a migrated
 *  Frame; the planner refuses a snapshot holding a legacy `w:` key. */
export function stackItemsFor(v: FrameVariant): StackItem[] {
  const byId = new Map(v.layers.map(l => [l.id, l]))
  const out: StackItem[] = []
  for (const key of v.stackOrder) {
    if (!key.startsWith('l:')) continue
    const layer = byId.get(key.slice(2))
    if (layer) out.push({ type: 'local', key, layer })
  }
  return out
}

const frameSurface: EmbedSurface = {
  kind: 'frame',
  // Genuinely true: with no background the painter never fills, so the canvas keeps its
  // transparent pixels. The sheet only offers a transparent export when the background is empty.
  caps: { alpha: true },

  async mount(container: HTMLElement, config: unknown): Promise<EmbedHandle> {
    const snap = config as FrameSnapshot
    const v = snap.variants?.[0]
    if (!v) throw new Error('embed: frame snapshot has no variant')
    const urls = snap.assets.urls
    const unregister = registerAssetResolver((kind, key) => urls[assetKey(kind, key)] ?? null)
    const styles: HTMLStyleElement[] = []
    const cleanup = () => { unregister(); for (const s of styles) s.remove() }

    try {
      for (const f of snap.assets.fonts) {
        const el = document.createElement('style')
        el.dataset.sailorEmbedFont = fontFaceId(f.family, f.weight)
        el.textContent = fontFaceRule(f)
        document.head.appendChild(el)
        styles.push(el)
      }
      for (const f of snap.assets.fonts) {
        const w = typeof f.weight === 'number' ? f.weight : f.weight[0]
        const faces = await document.fonts.load(`${w} 16px '${f.family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
        if (!faces.length) throw new Error(`embed: font "${f.family}" did not load`)
      }
      await document.fonts.ready

      addShaderFxEffects(snap.assets.shaders)
      const ready = await Promise.all(snap.assets.shaders.map(d => whenFieldEffectReady(d.id)))
      if (!ready.every(Boolean)) throw new Error('embed: a shader did not become ready')

      for (const d of snap.assets.depth) seedDepthImage(d.ref, await loadImage(d.dataUrl))

      const stills = new Map<number, HTMLImageElement>()
      for (const [slot, entry] of Object.entries(snap.wired ?? {})) stills.set(Number(slot), await loadImage(entry.dataUrl))

      const layers = v.layers as LocalLayer[]
      await ensureLayerImages(layers, { keep: true })
      if (!(await ensureRevealShadersReady(v.motion?.behaviours))) throw new Error('embed: a transition shader did not become ready')

      const canvas = document.createElement('canvas')
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.width = Math.max(1, Math.round(v.width))
      canvas.height = Math.max(1, Math.round(v.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('embed: no 2D context')

      const items = stackItemsFor(v)
      const provider = (slot: number) => stills.get(slot) ?? null
      let lastT = 0

      const paint = (t01: number) => {
        lastT = t01
        const tSec = t01 * snap.duration
        const r = fitRect({ w: canvas.width, h: canvas.height }, { w: v.width, h: v.height }, snap.fit)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (v.background != null) {
          ctx.setTransform(r.scale, 0, 0, r.scale, 0, 0)
          paintLayerStack(ctx, canvas.width / r.scale, canvas.height / r.scale, [], [],
            undefined, tSec, undefined, undefined, v.background, undefined, undefined, true)
        }
        ctx.setTransform(r.scale, 0, 0, r.scale, r.x, r.y)
        withWiredContent(provider, () => paintLayerStack(ctx, v.width, v.height, items, layers,
          undefined, tSec, v.motion ?? undefined, v.wiredTreatments, undefined, v.groups, v.post, true))
      }

      container.appendChild(canvas)
      paint(0)

      return {
        setTime: paint,
        setSize(w: number, h: number) {
          canvas.width = Math.max(1, Math.round(w))
          canvas.height = Math.max(1, Math.round(h))
          paint(lastT)
        },
        destroy() { canvas.remove(); cleanup() },
      }
    } catch (err) {
      cleanup()
      throw err
    }
  },
}

export default frameSurface
