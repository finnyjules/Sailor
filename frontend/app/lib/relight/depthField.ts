/**
 * The depth field Relight lights. Made once per image from the 8-bit depth PNG:
 * 1. to floats, 2. edge-preserving smoothing (melts the 8-bit steps that light up as contour
 * stripes, but keeps the subject/background jump a jump — blurring across it drew a grey halo),
 * 3. joint-bilateral upsampling guided by the photo, so depth edges follow the photo's real edges
 * instead of the depth map's coarse grid (stair-steps), 4. rows flipped into GL order.
 * The pure steps are unit-tested; `relightDepthFieldFor` is the cached browser entry.
 */
export interface FloatDepth { kind: 'float'; width: number; height: number; data: Float32Array }

/** Guide/field resolution cap: the field is built at the guide's size, at most this on its long edge. */
export const FIELD_MAX_EDGE = 1536

export function depthToFloat(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = rgba[i * 4]! / 255
  return out
}

export function bilateralSmooth(src: Float32Array, w: number, h: number, radius: number, sigma: number): Float32Array {
  const k2 = 1 / (2 * sigma * sigma)
  let a = src, b = new Float32Array(w * h)
  const pass = (from: Float32Array, to: Float32Array, horiz: boolean) => {
    const n = horiz ? w : h, lines = horiz ? h : w
    for (let l = 0; l < lines; l++) {
      for (let k = 0; k < n; k++) {
        const c = from[horiz ? l * w + k : k * w + l]!
        let sum = 0, ws = 0
        for (let j = -radius; j <= radius; j++) {
          const m = Math.min(n - 1, Math.max(0, k + j))
          const v = from[horiz ? l * w + m : m * w + l]!
          const wt = Math.exp(-(v - c) * (v - c) * k2)
          sum += v * wt; ws += wt
        }
        to[horiz ? l * w + k : k * w + l] = sum / ws
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    pass(a, b, true)
    const c = new Float32Array(w * h); pass(b, c, false); a = c
  }
  return a
}

/** Coarse depth → guide resolution, averaging 7×7 coarse neighbours weighted by how close the
 *  photo's colour at each neighbour is to this pixel's colour. Sampling is bilinear. */
export function jointUpsample(depth: Float32Array, dw: number, dh: number, guide: Uint8ClampedArray, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh)
  const sc = 1 / (2 * 0.07 * 0.07)
  const dAt = (u: number, v: number) => {           // bilinear in the coarse depth, u,v in 0..1
    const x = Math.min(dw - 1, Math.max(0, u * dw - 0.5)), y = Math.min(dh - 1, Math.max(0, v * dh - 0.5))
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dh - 1, y0 + 1)
    const fx = x - x0, fy = y - y0
    const t = depth[y0 * dw + x0]! * (1 - fx) + depth[y0 * dw + x1]! * fx
    const bm = depth[y1 * dw + x0]! * (1 - fx) + depth[y1 * dw + x1]! * fx
    return t * (1 - fy) + bm * fy
  }
  const gAt = (x: number, y: number, c: number) => guide[(Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))) * 4 + c]! / 255
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const r0 = gAt(x, y, 0), g0 = gAt(x, y, 1), b0 = gAt(x, y, 2)
      const u = (x + 0.5) / gw, v = (y + 0.5) / gh
      let sum = 0, ws = 0
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const su = u + (i * 0.75) / dw, sv = v + (j * 0.75) / dh
          const gx = Math.round(su * gw - 0.5), gy = Math.round(sv * gh - 0.5)
          const dr = gAt(gx, gy, 0) - r0, dg = gAt(gx, gy, 1) - g0, db = gAt(gx, gy, 2) - b0
          const w = Math.exp(-(i * i + j * j) / 8) * Math.exp(-(dr * dr + dg * dg + db * db) * sc)
          sum += dAt(su, sv) * w; ws += w
        }
      }
      out[y * gw + x] = sum / ws
    }
  }
  return out
}

export function toGlRows(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) out.set(src.subarray(y * w, (y + 1) * w), (h - 1 - y) * w)
  return out
}

export function buildDepthField(depthRgba: Uint8ClampedArray, dw: number, dh: number, guideRgba: Uint8ClampedArray, gw: number, gh: number): FloatDepth {
  const smooth = bilateralSmooth(depthToFloat(depthRgba, dw, dh), dw, dh, Math.max(5, Math.round(Math.max(dw, dh) / 120)), 0.035)
  return { kind: 'float', width: gw, height: gh, data: toGlRows(jointUpsample(smooth, dw, dh, guideRgba, gw, gh), gw, gh) }
}

// ── Browser entry, cached ──────────────────────────────────────────────────
const cache = new Map<string, FloatDepth>()
export function __resetRelightDepthFields(): void { cache.clear() }

function pixelsOf(src: CanvasImageSource, w: number, h: number): Uint8ClampedArray | null {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })
  if (!x) return null
  x.drawImage(src, 0, 0, w, h)
  return x.getImageData(0, 0, w, h).data
}

/**
 * The field for one image. `key` is the depth registry key (`depthKey(ref)`), so the same
 * picture on two layers or at two sizes shares one field. `guide` is the layer's own content at
 * any size; it is resampled to at most FIELD_MAX_EDGE. Returns null if a 2D context is refused.
 */
export function relightDepthFieldFor(key: string, depth: CanvasImageSource & { width?: number; height?: number }, guide: HTMLCanvasElement): FloatDepth | null {
  const hit = cache.get(key)
  if (hit) return hit
  const dw = (depth as HTMLImageElement).naturalWidth || (depth as HTMLCanvasElement).width
  const dh = (depth as HTMLImageElement).naturalHeight || (depth as HTMLCanvasElement).height
  if (!dw || !dh) return null
  const s = Math.min(1, FIELD_MAX_EDGE / Math.max(guide.width, guide.height))
  const gw = Math.max(1, Math.round(guide.width * s)), gh = Math.max(1, Math.round(guide.height * s))
  const dpx = pixelsOf(depth, dw, dh), gpx = pixelsOf(guide, gw, gh)
  if (!dpx || !gpx) return null
  const field = buildDepthField(dpx, dw, dh, gpx, gw, gh)
  if (cache.size >= 8) cache.delete(cache.keys().next().value!)
  cache.set(key, field)
  return field
}
