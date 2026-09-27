// How text and boxes land on the layout grid vertically (spec 2026-09-26-frame-layout-grid-design,
// "Snapping"). Pure: grid px in, grid px out. Text snaps by what is drawn — its capitals to a row
// top (or the top margin), its last baseline to a row bottom (or the bottom margin), else its first
// baseline to the baseline grid (every `unit` from the Frame's top).
import type { ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

/** A text layer's capitals and baselines, absolute px on the grid. */
export interface TextMarks { capTop: number; baselines: number[] }

/** The vertical move that puts text on the grid. `guide` is the line it snapped to, or null for the
 *  baseline-grid fallback (which always applies: every baseline is at most unit/2 from a line). */
export function textSnapY(m: TextMarks, r: ResolvedLayoutGrid, reach: number): { dy: number; guide: number | null } {
  const tops = [...r.rows.map(t => t.a), r.top]
  const bottoms = [...r.rows.map(t => t.a + t.w), r.bottom]
  let best: { dy: number; guide: number } | null = null
  const consider = (from: number, lines: number[]) => {
    for (const t of lines) {
      const d = t - from
      if (Math.abs(d) < reach && (!best || Math.abs(d) < Math.abs(best.dy))) best = { dy: d, guide: t }
    }
  }
  consider(m.capTop, tops)
  const last = m.baselines[m.baselines.length - 1]
  if (last != null) consider(last, bottoms)
  if (best) return best
  const first = m.baselines[0] ?? m.capTop
  return { dy: baselineRoundDy(first, r.unit), guide: null }
}

/** The move that puts `top` on the baseline grid (nothing within reach: a box's top rounds to it). */
export function baselineRoundDy(top: number, unit: number): number {
  if (!(unit > 0)) return 0
  return Math.round(top / unit) * unit - top
}

/** How far Re-snap looks for a row top/bottom for text: half a row pitch (so it always finds the
 *  nearest row) when there are rows to pitch between; otherwise one line, toward the margins. */
export function resnapReach(r: ResolvedLayoutGrid): number {
  return r.rows.length > 1 ? (r.rows[1]!.a - r.rows[0]!.a) / 2 : 2 * r.unit
}
