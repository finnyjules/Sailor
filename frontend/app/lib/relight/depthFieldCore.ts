/**
 * The pure half of the Relight depth field: 8-bit depth PNG pixels + the photo's pixels in, a
 * float field out. No DOM — it runs in the field worker (depthFieldWorker.ts), in node unit
 * tests, and on the main thread only as the no-Worker fallback. See depthField.ts for the steps.
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

/** The field's size for a source image: its own aspect, long edge capped at FIELD_MAX_EDGE. */
export function fieldSizeFor(srcW: number, srcH: number): { w: number; h: number } {
  const s = Math.min(1, FIELD_MAX_EDGE / Math.max(srcW, srcH, 1))
  return { w: Math.max(1, Math.round(srcW * s)), h: Math.max(1, Math.round(srcH * s)) }
}

/** Which part of the source image the layer box shows, in top-down source fractions
 *  (u0, v0 = top left; du, dv = size). The field covers the whole image; the shader reads
 *  depth through this rect so a cropped layer is lit by the part of the shape it shows. */
export interface DepthRect { u0: number; v0: number; du: number; dv: number }
export const FULL_DEPTH_RECT: DepthRect = Object.freeze({ u0: 0, v0: 0, du: 1, dv: 1 })

/** Whether a source element has real pixels yet: a decoded image, or a canvas with a size.
 *  Building from an undecoded image would read a blank guide and cache a flat field. */
export function relightSourceReady(src: unknown): boolean {
  if (!src || typeof src !== 'object') return false
  const s = src as { complete?: boolean; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  if (typeof s.naturalWidth === 'number') return s.complete !== false && s.naturalWidth > 0 && (s.naturalHeight ?? 0) > 0
  return (s.width ?? 0) > 0 && (s.height ?? 0) > 0
}

/** Default byte cap for cached fields (Float32, so a 1536×1024 field is 6 MB). */
export const FIELD_CACHE_MAX_BYTES = 64 * 1024 * 1024

/**
 * Fields by depth key, capped by bytes, least recently used first out. A field `pin`ned during
 * the current paint is never evicted (the cap may run over rather than evict what is on screen);
 * `unpinAll` starts the next paint.
 */
export class RelightFieldCache {
  private map = new Map<string, FloatDepth>()
  private pinned = new Set<string>()
  bytes = 0
  constructor(public maxBytes = FIELD_CACHE_MAX_BYTES) {}

  get size(): number { return this.map.size }
  has(key: string): boolean { return this.map.has(key) }
  keys(): string[] { return [...this.map.keys()] }

  get(key: string): FloatDepth | null {
    const f = this.map.get(key)
    if (!f) return null
    this.map.delete(key); this.map.set(key, f)             // LRU: a hit becomes the newest
    return f
  }

  pin(key: string): void { this.pinned.add(key) }
  unpinAll(): void { this.pinned.clear() }

  set(key: string, field: FloatDepth): void {
    const old = this.map.get(key)
    if (old) { this.bytes -= old.data.byteLength; this.map.delete(key) }
    this.map.set(key, field)
    this.bytes += field.data.byteLength
    for (const k of [...this.map.keys()]) {
      if (this.bytes <= this.maxBytes) break
      if (k === key || this.pinned.has(k)) continue
      this.bytes -= this.map.get(k)!.data.byteLength
      this.map.delete(k)
    }
  }

  clear(): void { this.map.clear(); this.pinned.clear(); this.bytes = 0 }
}
