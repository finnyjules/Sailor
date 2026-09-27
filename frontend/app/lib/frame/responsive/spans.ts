// frontend/app/lib/frame/responsive/spans.ts
// What a responsive Frame's layer holds to (spec 2026-09-26-frame-layout-grid-design, "Responsive
// Frames"): the columns — and, with rows on, the rows — it covers on the Frame's layout grid, found
// the way the Layer section's Column/Span finds them (`spanOf`), placed on the same span of the grid
// resolved at the viewing size. Per axis: an axis with nothing to hold to holds to the frame. Pure.
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import { cornerPinActive, textVAlignCenterOffset } from '~/composables/useCompositorLayers'
import type { FrameFormat } from '~/lib/frame/formats'
import { resolveLayoutGrid, spanOf, placeOnSpan, type LayoutGrid, type ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'
import { textMetrics } from '~/lib/frame/textMetrics'
import { fitScale } from './axis'
import type { Unit } from './units'

export interface GridPair { design: ResolvedLayoutGrid; view: ResolvedLayoutGrid; s: number }

/**
 * The layout grid at the design size and at a W×H viewing size, whose px (margin, gutter, line,
 * fixed column width) follow the fit scale `s`, as `unitW` always did. The resolver holds layers to
 * `view` and the editor's overlay draws it — one function, so the two can't differ.
 */
export function gridsAt(grid: LayoutGrid | null, fmt: FrameFormat | null, W0: number, H0: number, W: number, H: number): GridPair | null {
  if (!grid || !(W0 > 0) || !(H0 > 0) || !(W > 0) || !(H > 0)) return null
  const s = fitScale(W0, H0, W, H)
  return { design: resolveLayoutGrid(grid, W0, H0, fmt), view: resolveLayoutGrid(grid, W, H, fmt, s), s }
}

/**
 * Which rows (0-based, inclusive) a design span r0..r1 of n rows keeps at a size with m rows.
 * Same count: the same rows. Every row: every row. Otherwise the span keeps its length (capped at m)
 * and its place from the nearer end — or from the middle, when it has rows on both sides and they
 * differ by at most one. null when the view has no rows.
 */
export function holdRows(r0: number, r1: number, n: number, m: number): [number, number] | null {
  if (m <= 0 || n <= 0) return null
  if (m === n) return [r0, r1]
  if (r0 <= 0 && r1 >= n - 1) return [0, m - 1]
  const len = Math.min(m, r1 - r0 + 1)
  const above = r0, below = n - 1 - r1
  let a: number
  if (above > 0 && below > 0 && Math.abs(above - below) <= 1) a = r0 + Math.round((m - n) / 2)
  else if (above <= below) a = r0
  else a = (m - 1 - below) - (len - 1)
  a = Math.min(Math.max(0, a), m - len)
  return [a, a + len - 1]
}

/** One axis of a reference rectangle: where it starts and how long it is, design px and view px. */
export interface AxisRef { dStart: number; dExtent: number; bStart: number; bExtent: number }

export interface Hold {
  h: AxisRef; v: AxisRef
  /** Which axes hold to the grid (the others hold to the frame). */
  onGrid: { h: boolean; v: boolean }
  /** The vertical extent the row span, the gate and the vertical pin are read from (design px). */
  vBox: { y: number; h: number }
  /** May a vertical "Top and bottom" be inferred? False for a lone text on rows: its height follows its lines. */
  vCanStretch: boolean
}

/**
 * A lone flowing text's capitals-to-last-baseline extent (design px), as the Layer section measures
 * it; null for anything else (rotated or corner-pinned text, placed/path text, non-text).
 */
export function textRowBox(layer: LocalLayer | undefined, W0: number, H0: number, ctx: CanvasRenderingContext2D | null): { y: number; h: number } | null {
  if (!layer || layer.kind !== 'text' || layer.rotation || cornerPinActive(layer.cornerPin)) return null
  const m = textMetrics(layer as TextLayer, W0, ctx ?? undefined)
  if (!m || !m.baselines.length) return null
  const top = layer.y * H0 + textVAlignCenterOffset(layer, m.boxH) - m.boxH / 2
  return { y: top + m.capTop, h: m.baselines[m.baselines.length - 1]! - m.capTop }
}

/**
 * The rectangle a unit holds to, per axis. An axis holds to the unit's span on the grid when the
 * unit lies on that span (within `max(1 % of the design width, one grid unit)`); otherwise, or with
 * no grid, or with `holdTo: 'frame'`, or where the box reaches or passes a frame edge on that axis, it
 * holds to the frame — exactly the rectangle resolve used before.
 * `lone` is the unit's single layer when the unit is one layer (text reads its rows by what is drawn).
 */
export function holdOf(unit: Unit, lone: LocalLayer | undefined, pair: GridPair | null, W0: number, H0: number, W: number, H: number, ctx: CanvasRenderingContext2D | null): Hold {
  const box = unit.box
  const out: Hold = {
    h: { dStart: 0, dExtent: W0, bStart: 0, bExtent: W },
    v: { dStart: 0, dExtent: H0, bStart: 0, bExtent: H },
    onGrid: { h: false, v: false },
    vBox: { y: box.y, h: box.h },
    vCanStretch: true,
  }
  if (!pair || unit.pins?.holdTo === 'frame') return out
  const { design: d, view: v } = pair
  const tol = Math.max(0.01 * W0, d.unit)
  const text = textRowBox(lone, W0, H0, ctx)
  const vb = text ?? { y: box.y, h: box.h }
  const span = spanOf({ x: box.x, w: box.w, y: vb.y, h: vb.h }, d)
  const dp = placeOnSpan(span, d)
  // A box that reaches or passes a frame edge (a full-bleed background, a band to the edge) holds
  // to the FRAME on that axis, so it keeps meeting the edge at every size — even where the grid's
  // margin is within the tolerance and the box would otherwise read as on the outer columns/rows.
  const EDGE = 1e-3
  const hitsFrameH = box.x <= EDGE || box.x + box.w >= W0 - EDGE
  const hitsFrameV = box.y <= EDGE || box.y + box.h >= H0 - EDGE
  // Columns: the count is stored, so the same indices exist at every size.
  if (!hitsFrameH && box.x >= dp.x - tol && box.x + box.w <= dp.x + dp.w + tol) {
    const vp = placeOnSpan({ ...span, row: null, rows: null }, v)
    out.h = { dStart: dp.x, dExtent: dp.w, bStart: vp.x, bExtent: vp.w }
    out.onGrid.h = true
  }
  // Rows: Square rows change count with the shape, so the span keeps its rows by holdRows.
  if (!hitsFrameV && span.row != null && span.rows != null && dp.y != null && dp.h != null
    && vb.y >= dp.y - tol && vb.y + vb.h <= dp.y + dp.h + tol) {
    const held = holdRows(span.row - 1, span.row + span.rows - 2, d.rows.length, v.rows.length)
    if (held) {
      const a = v.rows[held[0]]!, b = v.rows[held[1]]!
      out.v = { dStart: dp.y, dExtent: dp.h, bStart: a.a, bExtent: b.a + b.w - a.a }
      out.onGrid.v = true
      out.vBox = vb
      out.vCanStretch = !text
    }
  }
  return out
}

/**
 * Every grid span a unit drawn over [a, b] (view px) on one axis could hold to at the viewing size —
 * those whose view extent holds [a, b] within the tolerance (scaled to the view) — each with the
 * design span that holds to it: the same columns, or every design row span `holdRows` keeps on
 * those view rows. Empty without a grid (or rows, down). An edit at a viewing size maps a drop back
 * through each, so the unit can re-hold where it lands.
 */
export function spansAtView(pair: GridPair | null, axis: 'h' | 'v', a: number, b: number, W0: number): AxisRef[] {
  if (!pair) return []
  const { design: d, view: v, s } = pair
  const tol = Math.max(0.01 * W0, d.unit) * s + 1e-6
  const out: AxisRef[] = []
  const holds = (lo: number, hi: number) => lo <= a + tol && hi >= b - tol
  if (axis === 'h') {
    const n = Math.min(v.cols.length, d.cols.length)
    for (let c0 = 0; c0 < n; c0++) {
      for (let c1 = c0; c1 < n; c1++) {
        const lo = v.cols[c0]!.a, hi = v.cols[c1]!.a + v.cols[c1]!.w
        if (lo > a + tol) break
        if (!holds(lo, hi)) continue
        out.push({ dStart: d.cols[c0]!.a, dExtent: d.cols[c1]!.a + d.cols[c1]!.w - d.cols[c0]!.a, bStart: lo, bExtent: hi - lo })
      }
    }
    return out
  }
  const n = d.rows.length, m = v.rows.length
  if (!n || !m) return out
  for (let r0 = 0; r0 < n; r0++) {
    for (let r1 = r0; r1 < n; r1++) {
      const held = holdRows(r0, r1, n, m)
      if (!held) continue
      const lo = v.rows[held[0]]!.a, hi = v.rows[held[1]]!.a + v.rows[held[1]]!.w
      if (!holds(lo, hi)) continue
      out.push({ dStart: d.rows[r0]!.a, dExtent: d.rows[r1]!.a + d.rows[r1]!.w - d.rows[r0]!.a, bStart: lo, bExtent: hi - lo })
    }
  }
  return out
}
