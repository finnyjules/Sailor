/**
 * PIL's `ImageFilter.MaxFilter(size)` on an 8-bit greyscale ("L") picture
 * (step 3, R3.7: Separate background and foreground grows its mask with it,
 * nodes_replicate.py:4680-4681).
 *
 * Pillow's RankFilter.filter expands the picture by `size // 2` on every side
 * before its rank filter, repeating the edge pixels (ImagingExpand), so each
 * pixel becomes the largest value in the `size` × `size` square around it,
 * clipped to the picture. The runner's fixture proves that edge rule against
 * the real PIL (scripts/runner_paid_fixtures.py --group split, `maxfilter`:
 * masks touching every edge and corner, 1 × 1 up to 320 × 200, sizes 3, 25
 * and 101, larger than the picture itself).
 *
 * A clipped square is a clipped row times a clipped column, so the filter is
 * two passes of a running maximum (a monotonic queue: O(pixels), whatever the
 * size): along each row, then down each column.
 *
 * ONE self-contained function, as ./core.ts `pixelsCore` is: it refers to
 * nothing outside itself but JavaScript built-ins, so the Frame's worker
 * runs it from its source text (compositor/worker.ts, `px.maxFilter`, with
 * its Stop checks) and tests call the same code in this thread.
 */
export function maxFilterCore() {
  /**
   * The running maximum of `n` values read from `src` at `off + i·stride`,
   * over [i − k, i + k] clipped to [0, n − 1], written to `out` the same way.
   * `q`: scratch for the queue of indices (at least n long).
   */
  function maxLine(src: Uint8Array, off: number, stride: number, n: number, k: number, out: Uint8Array, q: Int32Array): void {
    let head = 0
    let tail = 0
    let next = 0
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + k)
      while (next <= hi) {
        const v = src[off + next * stride]!
        while (tail > head && src[off + q[tail - 1]! * stride]! <= v) tail--
        q[tail++] = next
        next++
      }
      while (q[head]! < i - k) head++
      out[off + i * stride] = src[off + q[head]! * stride]!
    }
  }

  /**
   * MaxFilter(size) of a w × h greyscale picture (one byte a pixel, row by
   * row). `size` is odd and at least 1 (Python's `mask_grow * 2 + 1`).
   * `isStopped`: checked between rows and columns; Stop throws.
   */
  function maxFilterL(l: Uint8Array, w: number, h: number, size: number, isStopped?: () => boolean): Uint8Array {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || l.length !== w * h) {
      throw new Error('The mask to grow is not the size it says')
    }
    if (!Number.isInteger(size) || size < 1 || size % 2 === 0) throw new Error('The mask can only grow by a whole number of pixels')
    const k = (size - 1) / 2
    const rows = new Uint8Array(w * h)
    const out = new Uint8Array(w * h)
    const q = new Int32Array(Math.max(w, h))
    for (let y = 0; y < h; y++) {
      if (isStopped && isStopped()) throw new Error('Stopped')
      maxLine(l, y * w, 1, w, k, rows, q)
    }
    for (let x = 0; x < w; x++) {
      if (isStopped && isStopped()) throw new Error('Stopped')
      maxLine(rows, x, w, h, k, out, q)
    }
    return out
  }

  return { maxFilterL }
}

/** The core in this thread (tests; the worker builds its own from the source text). */
export const maxFilterL = maxFilterCore().maxFilterL
