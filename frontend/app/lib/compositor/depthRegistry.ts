/**
 * Depth maps for image layers, held so paintLayer can read them SYNCHRONOUSLY.
 *
 * paintLayer must never await — so depth readiness is state, not a render-time fetch.
 * A layer with no depth yet renders through unchanged, and subscribers re-render when
 * it arrives. One in-flight request per filename; an error is retryable.
 */

import { requestDepthEstimate } from '~/lib/compositor/depthRequest'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Where an image lives. An uploaded/local layer is a bare filename under input/; a
 * WIRED layer's image is an execution output under output/ or temp/. Both must work —
 * a feature that appears on one and not the other reads as a bug.
 */
export interface DepthSource {
  filename: string
  subfolder?: string
  type?: 'input' | 'output' | 'temp'
}

/** Call sites may pass a bare filename (the common input/ case) or a full source. */
export type DepthRef = string | DepthSource

const asSource = (ref: DepthRef): DepthSource =>
  typeof ref === 'string' ? { filename: ref } : ref

/**
 * Parse a wired layer's image URL back into a depth source.
 *
 * A wired layer identifies its image by a `/view?filename=…&subfolder=…&type=…` URL
 * rather than a bare filename. Returns null for anything we cannot estimate depth from —
 * notably the synthetic `live:<slot>` URL a live studio slot uses, which has no file
 * behind it at all.
 */
export function depthSourceFromViewUrl(url: string | null | undefined): DepthSource | null {
  if (!url || typeof url !== 'string') return null
  if (!url.includes('?')) return null                 // covers `live:<slot>`
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  const filename = q.get('filename') ?? ''
  if (!filename) return null
  const type = q.get('type') ?? 'input'
  if (type !== 'input' && type !== 'output' && type !== 'temp') return null
  const subfolder = q.get('subfolder') || undefined
  return { filename, subfolder, type }
}

/** Cache key. Includes root and subfolder, so the same basename in output/ and input/
 *  are not confused for one another. */
export function depthKey(ref: DepthRef): string {
  const s = asSource(ref)
  return `${s.type ?? 'input'}:${s.subfolder ?? ''}:${s.filename}`
}

interface Entry { status: Status; img: HTMLImageElement | null; message?: string }

let entries = new Map<string, Entry>()
let listeners = new Set<() => void>()

const notify = () => { for (const cb of [...listeners]) cb() }

/** /view proxies to ComfyUI, which takes `subfolder` as its own param — a slash inside
 *  `filename` does not resolve. */
export function depthUrl(depthFilename: string, subfolder: string): string {
  const q = new URLSearchParams({ filename: depthFilename, subfolder, type: 'input' })
  return `/view?${q}`
}

export function depthStatusFor(ref: DepthRef): Status {
  return entries.get(depthKey(ref))?.status ?? 'idle'
}

/** Synchronous by design — safe to call from inside a paint. */
export function depthImageFor(ref: DepthRef): HTMLImageElement | null {
  const e = entries.get(depthKey(ref))
  return e?.status === 'ready' ? e.img : null
}

export function depthMessageFor(ref: DepthRef): string {
  return entries.get(depthKey(ref))?.message ?? ''
}

export function onDepthChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function fail(key: string, message: string) {
  entries.set(key, { status: 'error', img: null, message })
  notify()
}

export function requestDepth(ref: DepthRef): void {
  const src = asSource(ref)
  if (!src?.filename) return
  const key = depthKey(src)
  const cur = entries.get(key)
  // 'error' is deliberately retryable; 'loading' and 'ready' are not re-requested.
  if (cur && cur.status !== 'error') return

  entries.set(key, { status: 'loading', img: null })
  notify()

  void (async () => {
    const est = await requestDepthEstimate(src)
    if (!est.ok) return fail(key, est.message)
    const url = depthUrl(est.depthFilename, est.subfolder)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { entries.set(key, { status: 'ready', img }); notify() }
    img.onerror = () => fail(key, 'depth map could not be decoded')
    img.src = url
  })()
}

/** A depth map that is already in hand — a web export ships the maps the editor had cached and
 *  seeds them here at mount, so a depth-of-field layer paints exactly as it did in the editor. */
export function seedDepthImage(ref: DepthRef, img: HTMLImageElement): void {
  entries.set(depthKey(ref), { status: 'ready', img })
  notify()
}

/** Test seam — clears cached entries and subscribers. */
export function __resetDepthRegistry(): void {
  entries = new Map()
  listeners = new Set()
}
