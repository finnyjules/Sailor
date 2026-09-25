// frontend/app/composables/useLayerAnimate.ts
// Client side of /api/frame/animate: turn an image layer's still into a looping,
// transparent clip. The route does the model call and the keying; this only ships the
// still up and hands the clip back. The caller attaches it with setLocal.
import { ref } from 'vue'
import type { ImageClip } from '~/lib/compositor/clip'
import { imageLayerUrl, type ImageLayer } from '~/composables/useCompositorLayers'
import { clipModel, clipPrice, clipSeconds } from '~/data/clip-models'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { requestCostConfirm } from '~/lib/costConfirmRequest'

/** Thrown when the person cancels at the cost confirm: nothing was sent, and there is no error to show. */
export class AnimateCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'AnimateCancelled' }
}

/**
 * Hosted: the attempt goes through the same cost confirm graph runs use (P5 fix
 * round 1), showing the credits the route holds for it — clipPriceCredits, the
 * shared price of the request it sends. True to go ahead.
 */
export async function confirmAnimateCost(model: string, seconds: number, hosted: boolean): Promise<boolean> {
  const spec = clipModel(model)
  const price = spec ? clipPrice(spec.id, seconds) : null
  if (!hosted || !spec || !price) return true
  const secs = clipSeconds(spec, seconds)
  return requestCostConfirm({
    usd: price.usd,
    approximate: false,
    breakdown: [{ id: 'frame-animate', label: `Animate: ${spec.name}, ${secs} s`, usd: price.usd }],
    hostedCredits: price.credits,
  })
}

async function stillAsDataUrl(layer: ImageLayer): Promise<string> {
  const res = await fetch(imageLayerUrl(layer.filename))
  if (!res.ok) throw new Error('Could not read the layer image')
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the layer image'))
    r.readAsDataURL(blob)
  })
}

export function useLayerAnimate() {
  // Read at setup, where the Nuxt context exists (not inside the click's async call).
  const hosted = hostedModeEnabled(useRuntimeConfig().public)
  const busy = ref(false)
  const error = ref('')

  async function animate(layer: ImageLayer, opts: { prompt: string; model: string; seconds: number }): Promise<ImageClip> {
    busy.value = true; error.value = ''
    try {
      if (!(await confirmAnimateCost(opts.model, opts.seconds, hosted))) throw new AnimateCancelled()
      const image = await stillAsDataUrl(layer)
      const res = await $fetch<{ dir: string; frames: number; fps: number; model: string; prompt: string }>('/api/frame/animate', {
        method: 'POST', body: { image, prompt: opts.prompt, model: opts.model, seconds: opts.seconds },
      })
      return { dir: res.dir, frames: res.frames, fps: res.fps, speed: 1, prompt: res.prompt, model: res.model }
    } catch (err: any) {
      if (!(err instanceof AnimateCancelled)) error.value = err?.data?.message || err?.message || 'Animate failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  return { busy, error, animate }
}
