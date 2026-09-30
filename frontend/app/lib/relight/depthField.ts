/**
 * The depth field Relight lights. Made once per SOURCE image (not per layer box) from the 8-bit
 * depth PNG:
 * 1. to floats, 2. edge-preserving smoothing (melts the 8-bit steps that light up as contour
 * stripes, but keeps the subject/background jump a jump — blurring across it drew a grey halo),
 * 3. joint-bilateral upsampling guided by the photo, so depth edges follow the photo's real edges
 * instead of the depth map's coarse grid (stair-steps), 4. rows flipped into GL order.
 * The pure steps live in depthFieldCore.ts (unit-tested, and what the worker runs);
 * `relightDepthFieldFor` is the cached browser entry, which builds in a Web Worker.
 */
export {
  type FloatDepth, type DepthRect, FIELD_MAX_EDGE, FULL_DEPTH_RECT, FIELD_CACHE_MAX_BYTES,
  depthToFloat, bilateralSmooth, jointUpsample, toGlRows, buildDepthField,
  fieldSizeFor, relightSourceReady, RelightFieldCache,
} from './depthFieldCore'
import { buildDepthField, fieldSizeFor, relightSourceReady, RelightFieldCache, type FloatDepth } from './depthFieldCore'

// ── Browser entry, cached ──────────────────────────────────────────────────
const cache = new RelightFieldCache()
/** Keys whose field is being built right now (worker job in flight). */
const pending = new Set<string>()
let listeners = new Set<() => void>()
const notify = () => { for (const cb of [...listeners]) cb() }

/** Called once a field finishes building, so whoever painted without it repaints. */
export function onRelightFieldReady(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Pinning: every field asked for in one synchronous paint is pinned against eviction until the
// next paint starts (the first request in a later task unpins the previous paint's set).
let paintOpen = false
function pinForThisPaint(key: string): void {
  if (!paintOpen) {
    cache.unpinAll()
    paintOpen = true
    queueMicrotask(() => { paintOpen = false })
  }
  cache.pin(key)
}

type Src = CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
const sizeOf = (s: Src) => ({ w: s.naturalWidth || s.width || 0, h: s.naturalHeight || s.height || 0 })

function pixelsOf(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray | null {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })
  if (!x) return null
  x.drawImage(src, 0, 0, w, h)
  return x.getImageData(0, 0, w, h).data
}

function buildSync(depth: Src, dw: number, dh: number, source: Src, gw: number, gh: number): FloatDepth | null {
  try {
    const dpx = pixelsOf(depth, dw, dh), gpx = pixelsOf(source, gw, gh)
    if (!dpx || !gpx) return null
    return buildDepthField(dpx, dw, dh, gpx, gw, gh)
  } catch { return null }                                    // e.g. a tainted source: draw plain

}

// ── Worker ─────────────────────────────────────────────────────────────────
let worker: Worker | null = null
/** Set once the worker path fails (no OffscreenCanvas, a script error): later builds run inline. */
let workerBroken = false
let jobSeq = 0
const jobs = new Map<number, string>()

function workerUsable(): boolean {
  return !workerBroken && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function'
    && typeof OffscreenCanvas !== 'undefined'
}

function workerFailed(reason: unknown): void {
  if (!workerBroken) console.warn('[relight] depth-field worker unavailable, building inline:', reason)
  workerBroken = true
  worker?.terminate(); worker = null
  for (const key of jobs.values()) pending.delete(key)
  jobs.clear()
  notify()                                                   // repaint: the next paint builds inline
}

function getWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./depthFieldWorker.ts', import.meta.url), { type: 'module' })
  } catch (err) { workerFailed(err); return null }
  worker.onmessage = (e: MessageEvent<{ id: number; width?: number; height?: number; data?: Float32Array; error?: string }>) => {
    const { id, error, width, height, data } = e.data
    const key = jobs.get(id)
    jobs.delete(id)
    if (key === undefined) return
    pending.delete(key)
    if (error || !data || !width || !height) { workerFailed(error ?? 'empty result'); return }
    cache.set(key, { kind: 'float', width, height, data })
    notify()
  }
  worker.onerror = (e) => { e.preventDefault?.(); workerFailed(e.message || 'worker error') }
  return worker
}

async function buildInWorker(key: string, depth: Src, dw: number, dh: number, source: Src, gw: number, gh: number): Promise<void> {
  try {
    const [db, gb] = await Promise.all([
      createImageBitmap(depth as ImageBitmapSource),
      createImageBitmap(source as ImageBitmapSource, { resizeWidth: gw, resizeHeight: gh, resizeQuality: 'high' }),
    ])
    const w = getWorker()
    if (!w) { db.close(); gb.close(); return }
    const id = ++jobSeq
    jobs.set(id, key)
    w.postMessage({ id, depth: db, dw, dh, guide: gb, gw, gh }, [db, gb])
  } catch (err) {
    pending.delete(key)
    workerFailed(err)
  }
}

/**
 * The field for one source image. `key` is the depth registry key (`depthKey(ref)`), so the same
 * picture on two layers, at two sizes or with two crops shares one field. `source` is the layer's
 * SOURCE image (the decoded bitmap / the wired live element), never its box-sized render; the
 * field is built at the source's aspect, long edge at most FIELD_MAX_EDGE.
 *
 * Returns null — draw plain — while the source or depth is not decoded (nothing is built or
 * cached), and while the field is building in the worker; `onRelightFieldReady` fires when it
 * lands. Without a Worker (node, odd environments) it builds synchronously and returns the field.
 */
export function relightDepthFieldFor(key: string, depth: Src, source: Src | null | undefined): FloatDepth | null {
  pinForThisPaint(key)
  const hit = cache.get(key)
  if (hit) return hit
  if (!source || !relightSourceReady(source) || !relightSourceReady(depth)) return null
  if (pending.has(key)) return null
  const d = sizeOf(depth), s = sizeOf(source)
  if (!d.w || !d.h || !s.w || !s.h) return null
  const g = fieldSizeFor(s.w, s.h)
  if (workerUsable()) {
    pending.add(key)
    void buildInWorker(key, depth, d.w, d.h, source, g.w, g.h)
    return null
  }
  const field = buildSync(depth, d.w, d.h, source, g.w, g.h)
  if (field) cache.set(key, field)
  return field
}

/** Test seams. */
export function __resetRelightDepthFields(): void {
  cache.clear(); pending.clear(); jobs.clear()
}
export function __relightFieldCacheKeys(): string[] { return cache.keys() }
