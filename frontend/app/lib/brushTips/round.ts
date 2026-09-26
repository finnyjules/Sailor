// Round tip replay: a lazy string smooths the pointer, dabs are stamped at 8% of the size,
// each with a few overspray specks just outside the edge. Ported from the prototype.
import { makeRng, type Rng2 } from './random'
import { DabBuffer } from './dabs'
import { REF_W, SIZE_MIN } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

export class RoundSim {
  readonly dabs = new DabBuffer(1024)
  private rng: Rng2
  private lazy: { x: number; y: number } | null = null
  private last: { x: number; y: number } | null = null
  private size: number; private S: Record<string, number>
  constructor(opts: { size: number; settings: Record<string, number>; seed: number }) {
    this.size = Math.max(SIZE_MIN, opts.size); this.S = opts.settings; this.rng = makeRng(opts.seed)
  }
  addSample(s: Sample) {
    // Quantise to the same 5 dp as `encodePts`, so a live-drawn stroke sims identically
    // to the same stroke decoded back from storage (record.ts rounds to this precision).
    const p = { x: (Math.round(s.x * 1e5) / 1e5) * REF_W, y: (Math.round(s.y * 1e5) / 1e5) * REF_W }
    if (!this.lazy) { this.lazy = { ...p }; this.last = { ...p }; this.stamp(p.x, p.y); return }
    const R = 3 * (this.S.smoothing ?? 1)
    const dx = p.x - this.lazy.x, dy = p.y - this.lazy.y, L = Math.hypot(dx, dy)
    if (L <= R) return
    this.lazy.x += dx * (L - R) / L; this.lazy.y += dy * (L - R) / L
    const step = Math.max(1, this.size * 0.08)
    let d = Math.hypot(this.lazy.x - this.last!.x, this.lazy.y - this.last!.y)
    while (d >= step) {
      this.last = { x: this.last!.x + (this.lazy.x - this.last!.x) * step / d, y: this.last!.y + (this.lazy.y - this.last!.y) * step / d }
      this.stamp(this.last.x, this.last.y)
      d -= step
    }
  }
  private stamp(x: number, y: number) {
    const S = this.S, rng = this.rng, r = this.size / 2
    this.dabs.push(x, y, r, 0.35, Math.max(0, Math.min(1, 1 - 0.3 * (S.softness ?? 1))))
    const O = S.overspray ?? 1
    const e = 0.5 * O * Math.max(1, this.size / 30)
    const n = Math.floor(e) + (rng.next() < e % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2, rr = r * (0.85 + Math.abs(rng.gauss()[0]) * 0.3 * Math.max(0.3, O))
      this.dabs.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0.3 + rng.next() * 0.45, 0.5, 1)
    }
  }
}

export function simulateRound(stroke: TipStroke): DabBuffer {
  const sim = new RoundSim({ size: stroke.size * REF_W, settings: stroke.settings, seed: stroke.seed })
  for (const s of decodePts(stroke.pts)) sim.addSample(s)
  return sim.dabs
}
