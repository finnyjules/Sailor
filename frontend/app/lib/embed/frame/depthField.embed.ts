/**
 * Embed-build stand-in for ~/lib/relight/depthField (aliased in vite.embed.config.ts).
 *
 * The app's depthField.ts builds Relight's depth field in a Web Worker
 * (`new Worker(new URL('./depthFieldWorker.ts', import.meta.url))`). Bundled into an export that
 * becomes a separate worker file URL — something an exported .html cannot carry, and which the
 * export's network scan refuses, so every Frame export was refused. An exported file builds the
 * field synchronously instead (the same pure steps, depthFieldCore.ts), once per source, cached.
 * This module must never import ./depthField or any Worker.
 */
export {
  type FloatDepth, type DepthRect, FIELD_MAX_EDGE, FULL_DEPTH_RECT, FIELD_CACHE_MAX_BYTES,
  depthToFloat, bilateralSmooth, jointUpsample, toGlRows, buildDepthField,
  fieldSizeFor, relightSourceReady, RelightFieldCache,
} from '~/lib/relight/depthFieldCore'
import { buildDepthField, fieldSizeFor, relightSourceReady, RelightFieldCache, type FloatDepth } from '~/lib/relight/depthFieldCore'

const cache = new RelightFieldCache()

/** Fields are built synchronously here, so nothing ever lands later: a no-op subscription. */
export function onRelightFieldReady(_cb: () => void): () => void {
  return () => {}
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

/** Same contract as the app's relightDepthFieldFor, built inline. */
export function relightDepthFieldFor(key: string, depth: Src, source: Src | null | undefined): FloatDepth | null {
  const hit = cache.get(key)
  if (hit) return hit
  if (!source || !relightSourceReady(source) || !relightSourceReady(depth)) return null
  const d = sizeOf(depth), s = sizeOf(source)
  if (!d.w || !d.h || !s.w || !s.h) return null
  const g = fieldSizeFor(s.w, s.h)
  let field: FloatDepth | null = null
  try {
    const dpx = pixelsOf(depth, d.w, d.h), gpx = pixelsOf(source, g.w, g.h)
    if (dpx && gpx) field = buildDepthField(dpx, d.w, d.h, gpx, g.w, g.h)
  } catch { field = null }                                   // e.g. a tainted source: draw plain
  if (field) cache.set(key, field)
  return field
}
