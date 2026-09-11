// frontend/app/composables/useLayerAnimate.ts
// Client side of /api/frame/animate: turn an image layer's still into a looping,
// transparent clip. The route does the model call and the keying; this only ships the
// still up and hands the clip back. The caller attaches it with setLocal.
import { ref } from 'vue'
import type { ImageClip } from '~/lib/compositor/clip'
import { imageLayerUrl, type ImageLayer } from '~/composables/useCompositorLayers'

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
  const busy = ref(false)
  const error = ref('')

  async function animate(layer: ImageLayer, opts: { prompt: string; model: string; seconds: number }): Promise<ImageClip> {
    busy.value = true; error.value = ''
    try {
      const image = await stillAsDataUrl(layer)
      const res = await $fetch<{ dir: string; frames: number; fps: number; model: string; prompt: string }>('/api/frame/animate', {
        method: 'POST', body: { image, prompt: opts.prompt, model: opts.model, seconds: opts.seconds },
      })
      return { dir: res.dir, frames: res.frames, fps: res.fps, speed: 1, prompt: res.prompt, model: res.model }
    } catch (err: any) {
      error.value = err?.data?.message || err?.message || 'Animate failed'
      throw err
    } finally {
      busy.value = false
    }
  }

  return { busy, error, animate }
}
