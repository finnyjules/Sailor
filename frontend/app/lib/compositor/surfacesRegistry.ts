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
 *
 * 2026-09-30 (Read shape button): the Frame editor no longer starts a paid read on its own.
 * Instead it PEEKS — a free `peekSurfacesFor` call, same signature watch as before — which
 * only ever lands an entry as 'ready' (already cached) or 'absent' (nothing cached: the
 * Relight panel shows the "Read shape" button). `requestSurfaces`, the paid read, now runs
 * only from that button's click (or directly, for a key with no entry yet — kept so callers
 * that skip the peek still get a first read, and so the existing money-loop-guard tests keep
 * their shape): it starts a read for no-entry or 'absent', and still never restarts
 * 'loading'/'ready'/'error'/'off' — 'error' stays retrySurfaces-only.
 */
import { requestSurfacesRead, peekSurfaces } from '~/lib/compositor/surfacesRequest'
import { type DepthRef, type DepthSource, depthKey } from '~/lib/compositor/depthRegistry'

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'off' | 'absent'

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

/** An exported file's surfaces, carried as an asset: ready at once (no request, no price). */
export function seedSurfacesImage(ref: DepthRef, img: HTMLImageElement): void {
  entries.set(depthKey(ref), { status: 'ready', img, paid: false })
  notify()
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
  const cur = entries.get(key)
  // Any existing entry other than 'absent' answers for itself: 'loading' and 'ready' need
  // nothing, 'error' waits for retrySurfaces, 'off' stays off (see the header — this is the
  // paid-route loop guard). 'absent' is a free peek's answer, not a read: the Read shape
  // button's click reaches here and must start the real, paid read.
  if (cur && cur.status !== 'absent') return
  start(src, key)
}

/** Free: asks the server whether this photo's surfaces are already cached, without ever
 *  starting a paid read. No-op when an entry already exists in ANY state — 'absent' included,
 *  so the watch that calls this on every layer-set change never re-peeks a photo it has
 *  already asked about; the button (`requestSurfaces`) is what moves 'absent' onward. At most
 *  one peek runs per key at a time. */
const peeking = new Set<string>()
const decoding = new Set<string>()

export function peekSurfacesFor(ref: DepthRef): void {
  const src = asSource(ref)
  if (!src?.filename) return
  const key = depthKey(src)
  if (entries.has(key) || peeking.has(key)) return
  peeking.add(key)
  void (async () => {
    let res: Awaited<ReturnType<typeof peekSurfaces>>
    try {
      res = await peekSurfaces(src)
    } catch (e) {
      res = { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) } as typeof res
    } finally {
      peeking.delete(key)
    }
    // A real read (the button, or a direct requestSurfaces call) may have started while the
    // peek was in flight — that entry always wins over a late peek answer.
    if (entries.has(key)) return
    if (!res.ok) {
      if (res.off) { off(key, res.message); return }
      // An ordinary peek failure is quiet: show the Read shape button as if nothing were
      // cached. A click does the real read, which answers from the cache when there is one.
      entries.set(key, { status: 'absent', img: null, paid: false })
      notify()
      return
    }
    if (res.absent) {
      entries.set(key, { status: 'absent', img: null, paid: false })
      notify()
      return
    }
    const url = surfacesUrl(res.normalsFilename, res.subfolder)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    // A cached map is still on its way until it decodes (no entry yet): the export waits for it.
    decoding.add(key)
    img.onload = () => { decoding.delete(key); entries.set(key, { status: 'ready', img, paid: false }); notify() }
    img.onerror = () => { decoding.delete(key); fail(key, 'surfaces map could not be decoded') }
    img.src = url
  })()
}

/** True while any photo's surfaces are on their way: a read ('loading'), a free peek, or a
 *  cached map still decoding. */
export function surfacesInFlight(): boolean {
  if (peeking.size || decoding.size) return true
  for (const e of entries.values()) if (e.status === 'loading') return true
  return false
}

/** Resolves once no surfaces are in flight, or after `timeoutMs` — whichever is first. The web
 *  export waits on this before planning, so a read about to land travels with the file. */
export function surfacesSettled(timeoutMs = 20_000): Promise<void> {
  if (!surfacesInFlight()) return Promise.resolve()
  return new Promise((resolve) => {
    let off: () => void = () => {}
    const done = () => { clearInterval(poll); clearTimeout(timer); off(); resolve() }
    const check = () => { if (!surfacesInFlight()) done() }
    off = onSurfacesChange(check)
    // A peek that finds an entry already set answers without a change event: poll too.
    const poll = setInterval(check, 200)
    const timer = setTimeout(done, timeoutMs)
  })
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
  peeking.clear()
  decoding.clear()
}
