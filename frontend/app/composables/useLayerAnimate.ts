// frontend/app/composables/useLayerAnimate.ts
// Client side of /api/frame/animate: turn an image layer's still into a looping,
// transparent clip. The route does the model call and the keying; this only ships the
// still up and hands the clip back. The caller attaches it with setLocal.
import { ref } from 'vue'
import type { ImageClip } from '~/lib/compositor/clip'
import { imageLayerUrl, type ImageLayer, type PendingAnimate } from '~/composables/useCompositorLayers'
import { clipModel, clipPrice, clipSeconds } from '~/data/clip-models'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { requestCostConfirm } from '~/lib/costConfirmRequest'

/** Thrown when the person cancels at the cost confirm (nothing was sent) or stops the attempt: there is no error to show. */
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

/** How often a pending attempt is looked at again. */
export const RESUME_POLL_MS = 5000

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
  // Stop (LC10): aborting the request closes it, and the route stops the model's
  // call (its hold released), the download and the keying, and leaves no folder.
  let inflight: AbortController | null = null
  let stopped = false

  function stop(): void {
    if (!inflight) return
    stopped = true
    inflight.abort()
  }

  /**
   * `onSent` (LC10 fix round 1) gets the attempt the moment it is about to be sent: the
   * caller keeps it on the layer (`pendingAnimate`), so a clip that was paid for and
   * finished after a Stop, a closed tab or a lost connection comes back through `resume`.
   */
  async function animate(layer: ImageLayer, opts: { prompt: string; model: string; seconds: number }, onSent?: (p: PendingAnimate) => void): Promise<ImageClip> {
    busy.value = true; error.value = ''
    const ctl = new AbortController()
    inflight = ctl; stopped = false
    try {
      if (!(await confirmAnimateCost(opts.model, opts.seconds, hosted))) throw new AnimateCancelled()
      const image = await stillAsDataUrl(layer)
      if (stopped) throw new AnimateCancelled()
      const attempt = crypto.randomUUID()
      onSent?.({ attempt, model: opts.model, prompt: opts.prompt, at: Date.now() })
      const res = await $fetch<{ dir: string; frames: number; fps: number; model: string; prompt: string }>('/api/frame/animate', {
        method: 'POST', body: { image, prompt: opts.prompt, model: opts.model, seconds: opts.seconds, attempt }, signal: ctl.signal,
      })
      return { dir: res.dir, frames: res.frames, fps: res.fps, speed: 1, prompt: res.prompt, model: res.model }
    } catch (err: any) {
      // Stopped by the person: nothing to show, the layer is untouched.
      if (stopped || ctl.signal.aborted) throw new AnimateCancelled()
      if (!(err instanceof AnimateCancelled)) error.value = err?.data?.message || err?.message || 'Animate failed'
      throw err
    } finally {
      if (inflight === ctl) inflight = null
      busy.value = false
    }
  }

  // ── picking up attempts that came back while nobody was waiting (LC10 fix round 1) ──
  const polling = new Map<string, ReturnType<typeof setTimeout> | null>()
  let disposed = false

  /**
   * For every layer with a `pendingAnimate`: ask the route where it stands, until it is
   * over. `apply(layerId, attempt, clip)`: the finished clip to add as a take, or null
   * when nothing came of it (stopped before anything was paid, failed, or unknown).
   * A failure after paying shows its words. Safe to call again: one look per attempt.
   */
  function resume(layers: readonly { id: string; kind?: string; pendingAnimate?: PendingAnimate }[], apply: (layerId: string, attempt: string, clip: ImageClip | null) => void): void {
    for (const l of layers) {
      const p = l.pendingAnimate
      if (!p || polling.has(p.attempt)) continue
      const look = async () => {
        if (disposed) return
        let next = true
        try {
          const r = await $fetch<{ state: string; paid: boolean; clip?: { dir: string; frames: number; fps: number; model: string; prompt: string }; message?: string }>(`/api/frame/animate/${p.attempt}`)
          if (r.state === 'done' && r.clip) { apply(l.id, p.attempt, { ...r.clip, speed: 1 }); next = false }
          else if (r.state === 'stopped' || r.state === 'failed') {
            if (r.state === 'failed' && r.paid && r.message) error.value = r.message
            apply(l.id, p.attempt, null); next = false
          }
        }
        catch (err: any) {
          // Unknown to the server (never sent, or not ours): nothing will come.
          if (err?.statusCode === 404 || err?.response?.status === 404) { apply(l.id, p.attempt, null); next = false }
        }
        if (next && !disposed) polling.set(p.attempt, setTimeout(look, RESUME_POLL_MS))
        else polling.delete(p.attempt)
      }
      polling.set(p.attempt, null)
      void look()
    }
  }

  /** Stops every look (the Frame closes). */
  function dispose(): void {
    disposed = true
    for (const t of polling.values()) if (t) clearTimeout(t)
    polling.clear()
  }

  return { busy, error, animate, stop, resume, dispose }
}
