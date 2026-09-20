import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, pmod, smoothstep, steppedPhase, travel } from './util'

const controls: ControlSpec[] = [
  { key: 'gridCols', label: 'Columns', kind: 'slider', min: 1, max: 8, step: 1, default: 4, group: 'Layout' },
  { key: 'gridGap', label: 'Gap', kind: 'slider', min: 0, max: 2, step: 0.05, default: 0.2, group: 'Layout' },
  { key: 'gridMotion', label: 'Grid motion', kind: 'select', options: ['wave', 'pop', 'flip', 'spotlight'], optionLabels: ['Wave', 'Pop', 'Flip', 'Spotlight'], default: 'wave', group: 'Motion' },
  // One strength dial for whichever Motion is chosen: how far the wave lifts, how deep a
  // pop shrinks, how far a flipping card comes forward, how large the spotlit card grows.
  // 0 is the plain static grid in every mode. (The key predates the other modes.)
  { key: 'gridWave', label: 'Amount', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, group: 'Motion' },
]

export const gridLayout: ShowcaseLayout = {
  id: 'grid', label: 'Grid', family: 'Grids and walls', controls,
  place(i, n, p, t01): TileTransform {
    const count = Math.max(1, n)
    const cols = Math.max(1, Math.round(Number(p.gridCols) || 1))
    const rows = Math.max(1, Math.ceil(count / cols))
    const size = Number(p.cardSize)
    const gap = size * (1 + Number(p.gridGap))
    const col = i % cols, row = Math.floor(i / cols)
    const x = (col - (cols - 1) / 2) * gap, y = -(row - (rows - 1) / 2) * gap
    const amount = Number(p.gridWave) || 0
    if (amount <= 0) return { x, y, z: 0, rotY: 0, scale: size }
    const diag = (col + row) / (cols + rows)                 // 0…1 across the grid, corner to corner
    const motion = String(p.gridMotion ?? 'wave')

    if (motion === 'pop' || motion === 'flip') {
      // Each card takes its turn once per trip, the turns sweeping corner to corner. `f`
      // runs 0…1 through a card's turn and sits at 0 the rest of the time.
      const f = smoothstep(0, 1, pmod(travel(p, t01, n) - diag, 1) * 3)
      const swing = Math.sin(Math.PI * f)                    // 0 → 1 → 0 across the turn
      if (motion === 'pop') return { x, y, z: swing * amount * 1.5, rotY: 0, scale: size * (1 - amount * swing * (f < 0.5 ? 1 : -0.35)) }
      return { x, y, z: swing * amount * 3, rotY: 2 * Math.PI * f, scale: size }
    }

    if (motion === 'spotlight') {
      // One card at a time comes forward to the middle and grows; the rest dim behind it.
      const r = pmod(i - steppedPhase(n, p, t01), count)
      const d = Math.min(r, count - r)                       // 0 on the spot, ≥ 1 everywhere else
      const lit = 1 - smoothstep(0, 1, d)
      const zoom = 1 + amount * Math.min(cols, rows) * 1.6
      return { x: x * (1 - lit), y: y * (1 - lit), z: lit * 2, rotY: 0, scale: size * (1 + (zoom - 1) * lit), opacity: 1 - 0.55 * (1 - lit) * amount }
    }

    // wave: a diagonal ripple — each card lifts toward the camera and swells a touch.
    const s = Math.sin(2 * Math.PI * (travel(p, t01, n) - diag))
    return { x, y, z: s * amount * 1.2, rotY: 0, scale: size * (1 + 0.06 * amount * s) }
  },
  loopRates(p) { return (Number(p.gridWave) || 0) > 0 ? loopRatesOf(p) : [] },
}
