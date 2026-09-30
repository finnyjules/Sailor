/**
 * Filled shapes on an 8-bit RGB picture (step 3, R6.7), for Audio
 * waveform's frames: Pillow's `rectangle`, its width-3 `line` and its
 * `ellipse`, drawn the way Pillow 12 draws them closely enough to look the
 * same (the user's matching rule, applied to R6.7: the waveform must look
 * the same side by side, not match Pillow bit for bit).
 *
 *   rectangle — every pixel from (x0, y0) to (x1, y1), both ends included,
 *               clipped to the picture (Pillow's own rule: exact);
 *   line      — each segment as Pillow's wide line: a four-cornered polygon
 *               around the segment, its corners the ends moved by the
 *               rounded perpendicular of half the width less a half
 *               (Draw.c ImagingDrawWideLine), filled with its edges;
 *   ellipse   — the pixels whose centres lie inside an ellipse fitted to
 *               Pillow's in the box (both ends included).
 *
 * SELF-CONTAINED, as the other cores are (./time.ts): the compositor worker
 * composes it from its source text (../cores.ts, `dr`). Do not reference
 * anything from outside the function's body.
 */
export interface Canvas8 { rgb: Uint8Array; w: number; h: number }

export function drawCore() {
  function canvas(w: number, h: number, bg: readonly number[]): Canvas8 {
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      rgb[3 * i] = bg[0]!
      rgb[3 * i + 1] = bg[1]!
      rgb[3 * i + 2] = bg[2]!
    }
    return { rgb, w, h }
  }

  /** One row's run from xa to xb (both included), clipped. */
  function span(c: Canvas8, y: number, xa: number, xb: number, ink: readonly number[]): void {
    if (y < 0 || y >= c.h) return
    const a = Math.max(0, xa)
    const b = Math.min(c.w - 1, xb)
    for (let x = a; x <= b; x++) {
      const i = 3 * (y * c.w + x)
      c.rgb[i] = ink[0]!
      c.rgb[i + 1] = ink[1]!
      c.rgb[i + 2] = ink[2]!
    }
  }

  /** Pillow's rectangle, filled: x0…x1 by y0…y1, both ends included. */
  function rectangle(c: Canvas8, x0: number, y0: number, x1: number, y1: number, ink: readonly number[]): void {
    for (let y = Math.max(0, y0); y <= Math.min(c.h - 1, y1); y++) span(c, y, x0, x1, ink)
  }

  /** Pillow's rounding of an offset (Draw.c ROUND_UP / ROUND_DOWN: halves away from and towards zero). */
  const roundUp = (v: number) => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(Math.abs(v) + 0.5))
  const roundDown = (v: number) => (v >= 0 ? Math.ceil(v - 0.5) : -Math.ceil(Math.abs(v) - 0.5))

  /** A convex polygon (integer corners), filled with its edges: each row from its leftmost crossing to its rightmost. */
  function convex(c: Canvas8, pts: readonly (readonly [number, number])[], ink: readonly number[]): void {
    let ymin = Infinity
    let ymax = -Infinity
    for (const [, y] of pts) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y) }
    for (let y = Math.max(0, ymin); y <= Math.min(c.h - 1, ymax); y++) {
      let lo = Infinity
      let hi = -Infinity
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k]!
        const [bx, by] = pts[(k + 1) % pts.length]!
        if (y < Math.min(ay, by) || y > Math.max(ay, by)) continue
        if (ay === by) { lo = Math.min(lo, ax, bx); hi = Math.max(hi, ax, bx); continue }
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay)
        lo = Math.min(lo, x)
        hi = Math.max(hi, x)
      }
      if (lo <= hi) span(c, y, roundUp(lo), roundDown(hi), ink)
    }
  }

  /** One segment of a line `width` wide (integer ends): Pillow's wide line. */
  function segment(c: Canvas8, x0: number, y0: number, x1: number, y1: number, width: number, ink: readonly number[]): void {
    const dx = x1 - x0
    const dy = y1 - y0
    if (dx === 0 && dy === 0) { span(c, y0, x0, x0, ink); return }
    const big = Math.hypot(dx, dy)
    const small = (width - 1) / 2.0
    const rMax = roundUp(small) / big
    const rMin = roundDown(small) / big
    const dxmin = roundDown(rMin * dy)
    const dxmax = roundDown(rMax * dy)
    const dymin = roundDown(rMin * dx)
    const dymax = roundDown(rMax * dx)
    convex(c, [[x0 - dxmin, y0 + dymax], [x1 - dxmin, y1 + dymax], [x1 + dxmax, y1 - dymin], [x0 + dxmax, y0 - dymin]], ink)
  }

  /** Pillow's line through integer points, `width` wide: each segment on its own (no joints). */
  function line(c: Canvas8, pts: readonly (readonly [number, number])[], width: number, ink: readonly number[]): void {
    for (let k = 0; k + 1 < pts.length; k++) segment(c, pts[k]![0], pts[k]![1], pts[k + 1]![0], pts[k + 1]![1], width, ink)
  }

  /**
   * Pillow's ellipse, filled, in the box x0…x1 by y0…y1 (both ends included):
   * the pixels whose centres lie inside the ellipse centred in the box with
   * half-axes of half the box's span plus ELLIPSE_GROW (fitted to Pillow 12's
   * own: 16 pixels differ over ten boxes from 2 × 2 to 64 × 40, all on the rim).
   */
  function ellipse(c: Canvas8, x0: number, y0: number, x1: number, y1: number, ink: readonly number[]): void {
    if (x1 < x0 || y1 < y0) return
    const ELLIPSE_GROW = 0.4
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const a = (x1 - x0) / 2 + ELLIPSE_GROW
    const b = (y1 - y0) / 2 + ELLIPSE_GROW
    for (let y = Math.max(0, y0); y <= Math.min(c.h - 1, y1); y++) {
      const v = (y - cy) / b
      const r = 1 - v * v
      if (r < 0) continue
      const half = a * Math.sqrt(r)
      span(c, y, Math.max(x0, Math.ceil(cx - half)), Math.min(x1, Math.floor(cx + half)), ink)
    }
  }

  return { canvas, rectangle, line, ellipse }
}

export type DrawCore = ReturnType<typeof drawCore>
