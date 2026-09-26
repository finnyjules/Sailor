// A growable flat list of dabs: x, y, radius, strength, hardness (Frame units).
export class DabBuffer {
  private buf: Float32Array
  count = 0
  constructor(initial = 1024) { this.buf = new Float32Array(Math.max(1, initial) * 5) }
  push(x: number, y: number, r: number, s: number, h: number): void {
    if ((this.count + 1) * 5 > this.buf.length) { const nb = new Float32Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb }
    const o = this.count * 5
    this.buf[o] = x; this.buf[o + 1] = y; this.buf[o + 2] = r; this.buf[o + 3] = s; this.buf[o + 4] = h
    this.count++
  }
  /** The filled part (a view, not a copy). */
  view(): Float32Array { return this.buf.subarray(0, this.count * 5) }
}
