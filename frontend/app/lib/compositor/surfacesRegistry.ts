/**
 * Photo surfaces (MoGe-2 normal maps) for Relight layers, held so paintLayer can read them
 * SYNCHRONOUSLY. Mirrors depthRegistry.ts's shape (one in-flight request per key, a paint
 * never awaits) with one difference that matters for money: requestSurfaces NEVER restarts
 * an existing entry, 'error' and 'off' included. The Frame editor calls it on every layer
 * change, so a restartable error would call the paid route again on each edit. An 'error'
 * restarts only through retrySurfaces (the Relight panel's Retry); 'off' stays off for the
 * session.
 *
 * Unlike depth, surfaces cost money on a miss. surfacesWasPaidFor says whether a request
 * that might be billed is in flight, so the Relight panel can show a price line: true from
 * request start until the answer, false the instant any answer lands (ready, a cache hit,
 * error or off). The price rule is in docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md.
 */
import { requestSurfacesRead } from '~/lib/compositor/surfacesRequest'
import { type DepthRef, type DepthSource, depthKey } from '~/lib/compositor/depthRegistry'

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'off'

const asSource = (ref: DepthRef): DepthSource =>
  typeof ref === 'string' ? { filename: ref } : ref

interface Entry { status: Status; img: HTMLImageElement | null; message?: string | null; paid: boolean }

let entries = new Map<string, Entry>()
let listeners = new Set<() => void>()

const notify = () => { for (const cb of [...listeners]) cb() }

/** /view proxies to ComfyUI, which takes `subfolder` as its own param — a slash inside
 *  `filename` does not resolve. */
export function surfacesUrl(normalsFilename: string, subfolder: string): string {
  const q = new URLSearchParams({ filename: normalsFilename, subfolder, type: 'input' })
  return `/view?${q}`
}

export function surfacesStatusFor(ref: DepthRef): Status {
  return entries.get(depthKey(ref))?.status ?? 'idle'
}

/** Synchronous by design — safe to call from inside a paint. */
export function surfacesImageFor(ref: DepthRef): HTMLImageElement | null {
  const e = entries.get(depthKey(ref))
  return e?.status === 'ready' ? e.img : null
}

export function surfacesMessageFor(ref: DepthRef): string | null {
  return entries.get(depthKey(ref))?.message ?? null
}

/** True while a request that is not (yet known to be) a cache hit is in flight — drives the
 *  Relight panel's price line. False once the answer lands, immediately for a cache hit. */
export function surfacesWasPaidFor(ref: DepthRef): boolean {
  return entries.get(depthKey(ref))?.paid ?? false
}

export function onSurfacesChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function fail(key: string, message: string) {
  entries.set(key, { status: 'error', img: null, message, paid: false })
  notify()
}

function off(key: string, message: string) {
  entries.set(key, { status: 'off', img: null, message, paid: false })
  notify()
}

/** The error message for a read that outlasted the server's poll (503 { retryLater }). */
export const SURFACES_STILL_READING = 'Still reading — try again in a minute'

function start(src: DepthSource, key: string): void {
  entries.set(key, { status: 'loading', img: null, paid: true })
  notify()

  void (async () => {
    const res = await requestSurfacesRead(src)
    if (!res.ok) {
      if (res.off) return off(key, res.message)
      return fail(key, res.retryLater ? SURFACES_STILL_READING : res.message)
    }
    const url = surfacesUrl(res.normalsFilename, res.subfolder)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { entries.set(key, { status: 'ready', img, paid: false }); notify() }
    img.onerror = () => fail(key, 'surfaces map could not be decoded')
    img.src = url
  })()
}

export function requestSurfaces(ref: DepthRef): void {
  const src = asSource(ref)
  if (!src?.filename) return
  const key = depthKey(src)
  // Any existing entry answers for itself: 'loading' and 'ready' need nothing, 'error' waits
  // for retrySurfaces, 'off' stays off (see the header — this is the paid-route loop guard).
  if (entries.has(key)) return
  start(src, key)
}

/** Retries an 'error' entry — the only way an error is ever requested again. Does nothing
 *  for 'off': the kill switch or a hosted refusal is a server decision, not a transient
 *  failure, so it is never retried; the entry clears only with the registry (a page load). */
export function retrySurfaces(ref: DepthRef): void {
  const src = asSource(ref)
  if (!src?.filename) return
  const key = depthKey(src)
  const cur = entries.get(key)
  if (!cur || cur.status !== 'error') return
  start(src, key)
}

/** Test seam — clears cached entries and subscribers. */
export function __resetSurfacesRegistry(): void {
  entries = new Map()
  listeners = new Set()
}
