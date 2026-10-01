/**
 * Blend scene's kept subject, cleaned (step 3, R8.1 live-check fix): the
 * mask of what the fill call repaints before the original is laid back.
 *
 * The model redraws the kept subject itself, often a little off its spot
 * (Flux Kontext drew a car slightly lower than it was placed), so laying the
 * original back over the answer left two subjects. Here, from the answer's
 * cut-out (Background remove's alpha) and the kept region (both brought to
 * the answer's size, 8-bit):
 *
 *  1. the kept region: the mask above 1/20;
 *  2. "near": the kept region grown by 15% of its box's longer side (at
 *     least 2 pixels), so a redrawn copy that moved is still found;
 *  3. the answer's subject: the cut-out's alpha at or above one half, split
 *     into its connected parts (4-connected); the parts that reach "near"
 *     are the model's copy (anything else in the scene is left alone);
 *  4. the fill: the copy ∪ the kept region, grown by 1% of the picture's
 *     longer side (at least 3 pixels) to take the copy's soft edge and halo.
 *
 * Nothing to fill (no kept region): `skip: 'empty'`. A copy covering more
 * than 60% of the picture (the remover took the whole scene as the subject):
 * `skip: 'too-large'`, and the answer is used as it is.
 *
 * ONE self-contained function taking the max-filter core (./maxFilter.ts),
 * so the Frame's worker runs it from its source text (`px.keepClean`, with
 * its Stop checks) and tests call the same code in this thread.
 */
export interface KeepCleanJob {
  /** The answer's cut-out alpha, w × h, one byte a pixel. */
  alpha: Uint8Array
  /** The kept region at the answer's size, w × h, one byte a pixel. */
  keep: Uint8Array
  w: number
  h: number
}

/**
 * What the worker's `px.keepClean` takes: the remover's alpha at its own size,
 * the kept region as its 16-bit PNG's inflated scanlines (keep.ts readMaskPng),
 * and the answer's size. The worker brings both to the answer's size (the
 * alpha by nearest pixel, the kept region bilinear, as Blend brings it to the
 * picture) and makes the fill's mask.
 */
export interface KeepCleanWork {
  alpha: Uint8Array
  aw: number
  ah: number
  mask16: Uint8Array
  mw: number
  mh: number
  w: number
  h: number
}

export type KeepCleanResult =
  | { mask: Uint8Array; copyPixels: number; keepPixels: number }
  | { skip: 'empty' | 'too-large' }

export function keepCleanCore(maxf: { maxFilterL(l: Uint8Array, w: number, h: number, size: number, stopped?: () => boolean): Uint8Array }) {
  function keepCleanMask(job: KeepCleanJob, stopped?: () => boolean): KeepCleanResult {
    const { alpha, keep, w, h } = job
    const n = w * h
    const check = () => { if (stopped && stopped()) throw new Error('Stopped') }
    // 1. The kept region and its box.
    const kept = new Uint8Array(n)
    let x0 = w, y0 = h, x1 = -1, y1 = -1, keepPixels = 0
    for (let y = 0; y < h; y++) {
      const r = y * w
      for (let x = 0; x < w; x++) {
        if (keep[r + x]! > 12) {
          kept[r + x] = 255
          keepPixels++
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (!keepPixels) return { skip: 'empty' }
    check()
    // 2. Near the kept region.
    const margin = Math.max(2, Math.round(0.15 * Math.max(x1 - x0 + 1, y1 - y0 + 1)))
    const near = maxf.maxFilterL(kept, w, h, 2 * margin + 1, stopped)
    check()
    // 3. The answer's subject, its parts reaching "near" (a scanline flood fill per part).
    const label = new Int32Array(n)
    const stack = new Int32Array(n)
    // reaches[k]: part k reaches "near" (parts are numbered from 1; at most n of them).
    const reaches = new Uint8Array(n + 1)
    let next = 0
    for (let i = 0; i < n; i++) {
      if (alpha[i]! < 128 || label[i]) continue
      if ((next & 0x3FF) === 0) check()
      next++
      let top = 0
      stack[top++] = i
      label[i] = next
      while (top) {
        const p = stack[--top]!
        if (near[p]) reaches[next] = 1
        const px = p % w
        if (px > 0 && !label[p - 1] && alpha[p - 1]! >= 128) { label[p - 1] = next; stack[top++] = p - 1 }
        if (px < w - 1 && !label[p + 1] && alpha[p + 1]! >= 128) { label[p + 1] = next; stack[top++] = p + 1 }
        if (p >= w && !label[p - w] && alpha[p - w]! >= 128) { label[p - w] = next; stack[top++] = p - w }
        if (p + w < n && !label[p + w] && alpha[p + w]! >= 128) { label[p + w] = next; stack[top++] = p + w }
      }
    }
    check()
    const copy = new Uint8Array(n)
    let copyPixels = 0
    for (let i = 0; i < n; i++) {
      if (label[i] && reaches[label[i]!]) { copy[i] = 255; copyPixels++ }
    }
    if (copyPixels > 0.6 * n) return { skip: 'too-large' }
    check()
    // 4. The fill: the copy and the kept region, grown.
    for (let i = 0; i < n; i++) if (kept[i]) copy[i] = 255
    const grow = Math.max(3, Math.round(0.01 * Math.max(w, h)))
    const mask = maxf.maxFilterL(copy, w, h, 2 * grow + 1, stopped)
    return { mask, copyPixels, keepPixels }
  }
  /** A one-byte-a-pixel picture brought to w × h by its nearest pixel (the remover's alpha, when its size differs). */
  function nearest(l: Uint8Array, lw: number, lh: number, w: number, h: number): Uint8Array {
    if (lw === w && lh === h) return l
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      const sy = Math.min(lh - 1, Math.floor((y + 0.5) * lh / h))
      for (let x = 0; x < w; x++) out[y * w + x] = l[sy * lw + Math.min(lw - 1, Math.floor((x + 0.5) * lw / w))]!
    }
    return out
  }
  return { keepCleanMask, nearest }
}
