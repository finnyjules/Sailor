// Steadying a trackpad hand before it paints, in client pixels: motion filtering (a One Euro
// filter: removes jitter when slow, no lag when fast) → stabilisation (a recency-weighted average
// over a short time window) → Streamline (the brush chases the result and catches up).
// Ported from docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html.

export interface SteadySettings { streamline: number; stabilise: number; filter: number; snap: boolean; hold: number }
export const STEADY_DEFAULTS: SteadySettings = { streamline: 0.3, stabilise: 0.15, filter: 0.4, snap: true, hold: 0.5 }
export type Pt = { x: number; y: number }
export type TPt = Pt & { t: number }

export const holdMsOf = (hold: number) => Math.round(250 + hold * 750)
const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d)
export function sanitizeSteady(raw: unknown): SteadySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const D = STEADY_DEFAULTS
  return {
    streamline: unit(r.streamline, D.streamline), stabilise: unit(r.stabilise, D.stabilise), filter: unit(r.filter, D.filter),
    snap: typeof r.snap === 'boolean' ? r.snap : D.snap, hold: unit(r.hold, D.hold),
  }
}

type Euro = { x: number | null; dx: number; t: number }
function euro(f: Euro, v: number, t: number, minCut: number, beta: number): number {
  if (f.x === null) { f.x = v; f.t = t; return v }
  const dt = Math.max(1e-3, (t - f.t) / 1000); f.t = t
  const al = (c: number) => { const r = 2 * Math.PI * c * dt; return r / (r + 1) }
  f.dx += al(1) * ((v - f.x) / dt - f.dx)
  f.x += al(minCut + beta * Math.abs(f.dx)) * (v - f.x)
  return f.x
}

export const STREAMLINE_TAU_MS = 220
export const STABILISE_WINDOW_MS = 220
export const RELEASE_TAU_SCALE = 0.3

export class Steadier {
  private fx: Euro = { x: null, dx: 0, t: 0 }
  private fy: Euro = { x: null, dx: 0, t: 0 }
  private buf: TPt[] = []
  private penT: number
  pen: Pt
  target: Pt
  private s: SteadySettings
  constructor(s: SteadySettings, x: number, y: number, t: number) {
    this.s = s
    this.pen = { x, y }; this.target = { x, y }; this.penT = t
    this.fx.x = null; this.fy.x = null
    euro(this.fx, x, t, 1, 0); euro(this.fy, y, t, 1, 0)
  }
  private get streaming() { return this.s.streamline > 0.001 }
  /** A raw pointer sample. Without Streamline, returns the steadied sample to paint now;
   *  with it, only moves the target (advance() paints the catch-up). */
  input(x: number, y: number, t: number): Pt[] {
    let q: Pt = { x, y }
    if (this.s.filter > 0.001) {
      const minCut = 0.25 + (1 - this.s.filter) * 7
      q = { x: euro(this.fx, x, t, minCut, 0.012), y: euro(this.fy, y, t, minCut, 0.012) }
    }
    if (this.s.stabilise > 0.001) {
      const win = this.s.stabilise * STABILISE_WINDOW_MS
      this.buf.push({ ...q, t })
      while (this.buf.length > 1 && t - this.buf[0]!.t > win) this.buf.shift()
      let sx = 0, sy = 0, sw = 0
      for (const b of this.buf) { const w = 1 + (b.t - (t - win)) / Math.max(1, win); sx += b.x * w; sy += b.y * w; sw += w }
      q = { x: sx / sw, y: sy / sw }
    }
    this.target = q
    if (this.streaming) return []
    this.pen = { ...q }; this.penT = t
    return [{ ...q }]
  }
  /** Streamline catch-up up to `now` (performance.now() / event timebase). */
  advance(now: number, releasing = false): { samples: TPt[]; caughtUp: boolean } {
    const out: TPt[] = []
    if (this.streaming) {
      const tau = this.s.streamline * STREAMLINE_TAU_MS * (releasing ? RELEASE_TAU_SCALE : 1)
      const dt = Math.max(0, now - this.penT), n = Math.max(1, Math.min(8, Math.ceil(dt / 4)))
      for (let i = 1; i <= n; i++) {
        const t = this.penT + dt * i / n, k = 1 - Math.exp(-(dt / n) / Math.max(1, tau))
        const nx = this.pen.x + (this.target.x - this.pen.x) * k, ny = this.pen.y + (this.target.y - this.pen.y) * k
        if (Math.hypot(nx - this.pen.x, ny - this.pen.y) < 0.05) break
        this.pen = { x: nx, y: ny }; out.push({ x: nx, y: ny, t })
      }
      this.penT = Math.max(this.penT, now)
    }
    return { samples: out, caughtUp: Math.hypot(this.target.x - this.pen.x, this.target.y - this.pen.y) < 0.6 }
  }
}

/** Is the finger holding still? A move over 3 px restarts the clock. */
export class HoldWatch {
  private ax: number; private ay: number; private at: number
  constructor(x: number, y: number, t: number) { this.ax = x; this.ay = y; this.at = t }
  move(x: number, y: number, t: number) { if (Math.hypot(x - this.ax, y - this.ay) > 3) { this.ax = x; this.ay = y; this.at = t } }
  stillFor(now: number) { return Math.max(0, now - this.at) }
}
