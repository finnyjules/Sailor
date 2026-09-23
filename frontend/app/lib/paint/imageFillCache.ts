/**
 * Decoded-bitmap cache for `ImageFill` paints, keyed by the fill's snapshot
 * `src`. The synchronous `resolvePaint`/`paintTileBox` arms read it via
 * `getFillBitmap`; render hosts fill it ahead of the paint pass via
 * `ensureFillBitmaps` (wired into `ensureLayerImages`) — the same
 * preload-then-paint shape image LAYERS already use. DOM is touched only inside
 * function bodies, so this stays importable by the CPU-only `lib/` modules.
 */
import { resolveAssetUrl } from '~/lib/compositor/assetScope'

const cache = new Map<string, HTMLImageElement>()
// A MAP, not a Set: a second `ensureFillBitmaps` for a src already decoding must
// AWAIT the same pending load, not skip it and return an immediately-resolved
// promise. The preview drawers chain `.then(redraw)`, and redraw re-calls
// `ensureFillBitmaps` while the bitmap is still loading — a synchronous resolve
// there is an infinite microtask loop that starves the event loop so the
// `<img>.onload` macrotask never runs (a hard tab freeze on selecting an image
// fill). Sharing the pending promise makes `.then(redraw)` fire once, on settle.
const inFlight = new Map<string, Promise<void>>()
const failed = new Set<string>()

/** A decoded bitmap for `src`, or null if it isn't loaded yet / failed. */
export function getFillBitmap(src: string): HTMLImageElement | null {
  const im = cache.get(src)
  return im && im.complete && im.naturalWidth > 0 ? im : null
}

/** Whether `src` previously failed to decode. Callers use this to stop
 *  re-requesting a dead URL on every redraw. */
export function hasFillBitmapFailed(src: string): boolean {
  return failed.has(src)
}

/** Decode every `src` not already loaded/in-flight/known-failed. Resolves when
 *  this call's jobs settle. `onReady` fires per successful decode so a host
 *  can re-render. */
export function ensureFillBitmaps(srcs: string[], onReady?: () => void): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const jobs: Promise<unknown>[] = []
  for (const src of srcs) {
    if (!src) continue
    if (getFillBitmap(src) || failed.has(src)) continue
    // Reuse the in-flight load if one exists; otherwise start it. Either way the
    // job resolves only when THIS src's decode actually settles.
    let job = inFlight.get(src)
    if (!job) {
      job = new Promise<void>((res) => {
        const im = new Image()
        im.crossOrigin = 'anonymous'
        im.onload = () => { failed.delete(src); cache.set(src, im); inFlight.delete(src); res() }
        im.onerror = () => { failed.add(src); inFlight.delete(src); res() }
        im.src = resolveAssetUrl('fillImage', src, src)
      })
      inFlight.set(src, job)
    }
    // `onReady` keeps its "per successful decode" contract — fire only if the
    // src actually landed in the cache, never on an error settle.
    jobs.push(onReady ? job.then(() => { if (getFillBitmap(src)) onReady() }) : job)
  }
  return jobs.length ? Promise.all(jobs).then(() => {}) : Promise.resolve()
}
