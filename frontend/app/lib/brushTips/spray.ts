// Spray can replay: a fixed-step (1/120 s) simulation of mist, specks, pooling and drips.
// Ported from the prototype (sprayTick / spawnDrip / updateDrips). Deterministic: the same
// record gives the same dabs however often advanceTo() is called. Frame units throughout.
import { makeRng, type Rng2 } from './random'
import { DabBuffer } from './dabs'
import { REF_W } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

const DT = 1 / 120
const DT_MS = 1000 / 120
interface Drip { x: number; y: number; vy: number; r: number; left: number; acc: number }

export class SpraySim {
  readonly dabs = new DabBuffer(4096)
  private rng: Rng2
  private samples: Sample[] = []
  private stepIdx = 0        // integer step counter — simT = stepIdx * DT_MS, never accumulated as a float
  private prev: { x: number; y: number } | null = null
  private wet = 0; private dripT = 0; private carry = 0
  private drips: Drip[] = []
  private released = false
  private size: number; private S: Record<string, number>

  constructor(opts: { size: number; settings: Record<string, number>; seed: number }) {
    this.size = opts.size; this.S = opts.settings; this.rng = makeRng(opts.seed)
  }
  get settled() { return this.released && this.drips.length === 0 }

  // Quantised to the same 5 dp as `encodePts`, so a live-drawn stroke sims identically
  // to the same stroke decoded back from storage (record.ts rounds to this precision).
  addSample(s: Sample) { this.samples.push({ x: Math.round(s.x * 1e5) / 1e5, y: Math.round(s.y * 1e5) / 1e5, t: Math.round(s.t) }) }
  release() { this.released = true }

  private nozzleAt(tMs: number): { x: number; y: number } {
    const P = this.samples
    let i = 0
    while (i + 1 < P.length && P[i + 1]!.t <= tMs) i++
    const a = P[i]!, b = P[Math.min(i + 1, P.length - 1)]!
    const f = b.t > a.t ? Math.min(1, Math.max(0, (tMs - a.t) / (b.t - a.t))) : 0
    return { x: (a.x + (b.x - a.x) * f) * REF_W, y: (a.y + (b.y - a.y) * f) * REF_W }
  }

  advanceTo(tMs: number) {
    if (!this.samples.length) return
    const limit = this.released ? tMs : Math.min(tMs, this.samples[this.samples.length - 1]!.t)
    while ((this.stepIdx + 1) * DT_MS <= limit + 1e-9) {
      this.stepIdx++
      const simT = this.stepIdx * DT_MS
      if (!this.released) {
        const b = this.nozzleAt(simT)
        const a = this.prev ?? b
        this.tick(a, b)
        this.prev = b
      }
      this.updateDrips()
    }
  }
  settle(maxMs = 2000) {
    const endStep = this.stepIdx + Math.round(maxMs / DT_MS)
    while (this.drips.length && this.stepIdx < endStep) this.advanceTo((this.stepIdx + 1) * DT_MS)
  }

  private tick(a: { x: number; y: number }, b: { x: number; y: number }) {
    const S = this.S, rng = this.rng, size = this.size, dt = DT
    const sig = size * 0.26, k = S.build ?? 1, rs = Math.max(1, size / 140)
    const moved = Math.hypot(b.x - a.x, b.y - a.y)
    // soft mist underneath, so the cloud fades out smoothly
    const steps = Math.max(1, Math.ceil(moved / (sig * 0.5)))
    for (let i = 1; i <= steps; i++) this.dabs.push(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, sig * 1.9, 2.1 * dt / steps * k, 0)
    // fine specks on top: the grain of a real can
    const want = dt * 5000 * (S.speckle ?? 1) * (size / 100) ** 2 + this.carry
    let n = Math.floor(want); this.carry = want - n; n = Math.min(n, 2500)
    const O = S.overspray ?? 1
    for (let i = 0; i < n; i++) {
      const t = rng.next(), cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t
      const over = rng.next() < Math.min(0.6, 0.22 * O), g = rng.gauss(), sg = over ? sig * (1 + 1.1 * O) : sig
      const r = (over ? 0.22 + rng.next() * 0.2 : 0.28 + rng.next() * rng.next() * 0.55) * rs
      this.dabs.push(cx + g[0] * sg, cy + g[1] * sg, r, (over ? 0.35 : 0.5 + rng.next() * 0.4) * k, 1)
    }
    // held still, the paint pools; pooled paint runs
    const D = S.drips ?? 0
    this.wet = moved < dt * 25 ? this.wet + dt : Math.max(0, this.wet - dt * 2)
    if (D > 0.01 && this.wet > 0.6 / D) {
      this.dripT -= dt
      if (this.dripT <= 0) { this.dripT = (0.25 + rng.next() * 0.4) / D; this.spawnDrip(b) }
    }
  }
  private spawnDrip(at: { x: number; y: number }) {
    const rng = this.rng, size = this.size, D = this.S.drips ?? 0
    const g = rng.gauss()
    const x = at.x + g[0] * size * 0.14
    const y = at.y + size * 0.12 + rng.next() * size * 0.08
    const vy = (45 + rng.next() * 60) * (0.6 + 0.4 * Math.min(2, D))
    const r = Math.max(1.3, size * 0.02) * (0.8 + rng.next() * 0.5)
    const left = (25 + rng.next() * size * 1.5) * D
    this.drips.push({ x, y, vy, r, left, acc: 0 })
  }
  private updateDrips() {
    const dt = DT
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i]!
      d.acc += d.vy * dt; d.vy *= Math.exp(-0.9 * dt)
      while (d.acc >= 1) { d.acc -= 1; d.y += 1; d.left -= 1; d.r *= 0.997; this.dabs.push(d.x + (this.rng.next() - 0.5) * 0.3, d.y, d.r, 0.85, 1) }
      if (d.left <= 0 || d.vy < 7) { this.dabs.push(d.x, d.y + d.r * 0.6, d.r * 1.55, 1, 1); this.drips.splice(i, 1) }
    }
  }
}

/** Replay a saved spray. `tailMs` limits how long drips run after the last sample:
 *  0 while the pointer is still down (live), the time since release while drips settle,
 *  and Infinity (default) for a finished stroke — capped by settle()'s 2 s. */
export function simulateSpray(stroke: TipStroke, tailMs = Infinity): { dabs: DabBuffer; settled: boolean } {
  const sim = new SpraySim({ size: stroke.size * REF_W, settings: stroke.settings, seed: stroke.seed })
  const samples = decodePts(stroke.pts)
  for (const s of samples) sim.addSample(s)
  const end = samples.length ? samples[samples.length - 1]!.t : 0
  sim.advanceTo(end)
  sim.release()
  if (tailMs === Infinity) sim.settle()
  else sim.advanceTo(end + Math.min(2000, Math.max(0, tailMs)))
  return { dabs: sim.dabs, settled: sim.settled }
}
