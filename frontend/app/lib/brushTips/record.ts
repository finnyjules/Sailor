// What a tip stroke saves: the movement, not the pixels. Replay rebuilds the paint.
import { REF_W, type TipId } from './tips'
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
  const size = s.size * REF_W, st = s.settings
  let side: number, down: number
  if (s.tip === 'spray') {
    const sig = size * 0.26, O = st.overspray ?? 0.2
    side = Math.max(sig * 1.9, sig * (1 + 1.1 * O) * 3.2)   // mist radius vs 3.2σ of overspray
    const D = st.drips ?? 0
    down = side + size * 0.2 + (25 + size * 1.5) * D + size * 0.1 // drip start + longest run + end blob
  } else if (s.tip === 'round') {
    side = size / 2 * (1 + 0.3 * Math.max(0.3, st.overspray ?? 0) * 3) + 1
    down = side
  } else {
    side = size * 1.25 / 2 + 2  // widest bristle width (1.2× size) plus ragged edge
    down = side
  }
  return { side: side / REF_W, up: side / REF_W, down: down / REF_W }
}
