import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { coverScale, loopRatesOf, pmod, travel, windowClip, type Rect } from './util'

const controls: ControlSpec[] = [
  { key: 'splitCols', label: 'Columns', kind: 'slider', min: 1, max: 4, step: 1, default: 2, group: 'Layout' },
  { key: 'splitRows', label: 'Cards per column', kind: 'slider', min: 1, max: 6, step: 1, default: 4, group: 'Layout' },
  { key: 'splitGap', label: 'Gap', kind: 'slider', min: 0, max: 0.3, step: 0.01, default: 0.06, group: 'Layout' },
]

// The room the grid may take, in world units; it shrinks to fit rather than overflow.
const FIT_W = 10, FIT_H = 11.5
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** Columns of pictures in a fixed frame. One column at a time scrolls up by a whole column's
 *  worth to a fresh set while the others hold, taking turns left to right. */
export const splitcolumnsLayout: ShowcaseLayout = {
  id: 'splitcolumns', label: 'Split columns', family: 'Grids and walls', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const count = Math.max(1, n)
    const cols = Math.max(1, Math.min(count, Math.round(Number(p.splitCols) || 1)))
    const rows = Math.max(1, Math.round(Number(p.splitRows) || 1))
    // Cards are dealt across the columns; each column cycles through its own share, `M`
    // long (a short last column just has a gap in its cycle).
    const col = i % cols, j = Math.floor(i / cols), M = Math.ceil(count / cols)
    // A column's move carries `rows` cards; it takes K moves to come round to where it began,
    // and the columns take turns, so a trip is cols × K steps.
    const K = M / gcd(M, rows), steps = cols * K
    const S = travel(p, t01, steps, 'step') * steps
    const q = S - col, moves = Math.floor(q / cols) + Math.min(1, pmod(q, cols))
    // Cell position down the column, 0 at the top; −1…0 is leaving through the top.
    const pos = pmod(j - moves * rows + 1, M) - 1
    const gap = Number(p.splitGap)
    const cell = Math.min(Number(p.cardSize) * 1.4, FIT_W / (cols + gap * (cols - 1)), FIT_H / (rows + gap * (rows - 1)))
    const g = gap * cell, colW = cell, gridW = cols * cell + (cols - 1) * g, gridH = rows * cell + (rows - 1) * g
    const hidden = { x: 0, y: 0, z: 0, rotY: 0, scale: 1e-3, opacity: 0 }
    if (pos <= -1 || pos >= rows) return hidden
    const cx = -gridW / 2 + colW / 2 + col * (colW + g)
    const cy = gridH / 2 - cell / 2 - pos * (cell + g)
    const aspect = aspects?.[i] || 1, scale = coverScale(aspect, cell, cell)
    // Cropped to its cell (cover), and the column to the grid's top and bottom edges.
    const slot: Rect = [cx - cell / 2, Math.max(-gridH / 2, cy - cell / 2), cx + cell / 2, Math.min(gridH / 2, cy + cell / 2)]
    const clip = windowClip(cx, cy, aspect * scale, scale, slot)
    return clip ? { x: cx, y: cy, z: 0, rotY: 0, scale, clip } : hidden
  },
  loopRates: loopRatesOf,
}
