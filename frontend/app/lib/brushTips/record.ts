// What a tip stroke saves: the movement, not the pixels. Replay rebuilds the paint.
import { REF_W, SIZE_MIN, SPRAY_DT, DRIP_DECAY, type TipId } from './tips'
import type { PaintStroke } from '~/lib/compositor/brushStamp'

export interface TipStroke {
  tip: TipId
  v: 1
  size: number                       // brush diameter, width-normalised (÷ artboard width)
  settings: Record<string, number>   // snapshot of the tip's settings when painted
  seed: number                       // uint32
  pts: number[]                      // flat x, y, t — x,y width-normalised (5 dp), t ms since start (integer)
  erase?: boolean
}
export interface Sample { x: number; y: number; t: number }

export function isTipStroke(s: PaintStroke | TipStroke | null | undefined): s is TipStroke {
  return !!s && typeof (s as TipStroke).tip === 'string'
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5
export function encodePts(samples: Sample[]): number[] {
  const out: number[] = []
  for (const p of samples) out.push(r5(p.x), r5(p.y), Math.round(p.t))
  return out
}
export function decodePts(pts: number[]): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i + 2 < pts.length; i += 3) out.push({ x: pts[i]!, y: pts[i + 1]!, t: pts[i + 2]! })
  return out
}

/** How far (width-normalised) a stroke's paint can reach past its path, per side. */
export function tipStrokePad(s: TipStroke): { side: number; up: number; down: number } {
  const size = Math.max(SIZE_MIN, s.size * REF_W), st = s.settings
  let side: number, down: number
  if (s.tip === 'spray') {
    // Mist radius vs a 4σ reach of the overspray specks (like round), plus the largest speck.
    const sig = size * 0.26, O = st.overspray ?? 0.2, rs = Math.max(1, size / 140)
    side = Math.max(sig * 1.9, sig * (1 + 1.1 * O) * 4) + 0.83 * rs
    down = side
    const D = st.drips ?? 0
    if (D > 0.01) {
      // Drips, from the physics in spray.ts spawnDrip / updateDrips: a drip starts up to
      // size·0.2 below the nozzle and moves 1 unit per unit of accumulated speed. Its speed
      // decays by DRIP_DECAY per step from vy0 ≤ (45+60)·(0.6+0.4·min(2,D)), so its whole run
      // is ≤ vy0·DT/(1−DRIP_DECAY) (≈ vy0/0.9), and never more than its `left` budget
      // (25 + size·1.5)·D plus the ≤2 units one step can overshoot. The end blob reaches
      // r·(0.6 + 1.55) past the last position, r ≤ max(1.3, size·0.02)·1.3.
      const vy0 = (45 + 60) * (0.6 + 0.4 * Math.min(2, D))
      const run = Math.min((25 + size * 1.5) * D + 2, vy0 * SPRAY_DT / (1 - DRIP_DECAY))
      const rMax = Math.max(1.3, size * 0.02) * 1.3
      down = Math.max(side, size * 0.2 + run + rMax * 2.15 + 0.5)
      side = Math.max(side, 4 * size * 0.14 + rMax * 1.55 + 0.15)   // a drip's 4σ sideways start
    }
  } else if (s.tip === 'round') {
    const r = size / 2
    side = r * (0.85 + 0.3 * Math.max(0.3, st.overspray ?? 0) * 4) + 1
    down = side
  } else {
    // Widest ribbon: widthFor peaks at size·(1 + 0.2·thin) when slow (thin ≥ 0), plus a margin
    // for the ragged edge and the spline's overshoot at corners.
    side = size * (1 + 0.2 * Math.max(0, st.thin ?? 1)) / 2 + 3
    down = side
  }
  return { side: side / REF_W, up: side / REF_W, down: down / REF_W }
}
