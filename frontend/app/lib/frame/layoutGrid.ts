// The Frame's layout grid — one standard grid per Frame (spec 2026-09-26-frame-layout-grid-design).
// Columns (count, gutter, margin in px at the design size; Stretch / Center / Left), rows (Off /
// Square / Count) that live on a baseline grid of half the body text's line spacing (`line`).
// Pure: no Vue, no DOM. Editor-only — nothing here is ever painted.
import type { FrameFormat } from '~/lib/frame/formats'
import { kitBasics, formatSheetOpts } from '~/lib/frame/patterns/kit/sheet'

export type ColumnFit = 'stretch' | 'center' | 'left'
export type RowMode = 'off' | 'square' | 'count'
export interface LayoutGrid {
  v: 2
  /** true = every value below is derived from the Frame's shape and format on read; false = the user's own. */
  auto: boolean
  show: boolean
  /** Body text line spacing, px at the design size. The baseline grid is every line / 2. */
  line: number
  cols: { count: number; fit: ColumnFit; margin: number; gutter: number; width: number }
  rows: { mode: RowMode; count: number }
}
export interface Track { a: number; w: number }
export interface ResolvedLayoutGrid {
  W: number; H: number
  /** The baseline grid step (line / 2, scaled). */
  unit: number
  cols: Track[]; rows: Track[]
  /** The real left margin — the first column's left edge. */
  margin: number
  /** Where rows may start / must end (margins and covered areas). */
  top: number; bottom: number
  /** Snap lines, px. */
  xs: number[]; ys: number[]
}
export interface LayoutGridPatch {
  columns?: number; gutter?: number; margin?: number; fit?: ColumnFit; width?: number
  rows?: RowMode; rowCount?: number; line?: number; show?: boolean
}

const DEFAULT_ROWS: LayoutGrid['rows'] = { mode: 'square', count: 8 }
const roundLine = (v: number) => Math.max(16, Math.round(v / 4) * 4)
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))
// Dedupes by a rounded key (so rounding artifacts collapse) but keeps each value's original,
// unrounded precision — callers compare these against the exact numbers they were built from.
const uniq = (vs: number[]) => {
  const seen = new Map<number, number>()
  for (const v of vs) {
    const k = Math.round(v * 1000) / 1000
    if (!seen.has(k)) seen.set(k, v)
  }
  return [...seen.values()].sort((a, b) => a - b)
}

export function suggestedLayoutGrid(W: number, H: number, fmt: FrameFormat | null, keep?: { show?: boolean; rows?: LayoutGrid['rows'] }): LayoutGrid {
  const k = kitBasics(W, H, formatSheetOpts(fmt))
  const px = W / 100
  const line = roundLine(k.infoSize * k.infoLh * px)
  const unit = line / 2
  const margin = Math.max(unit, Math.round((k.margin * px) / unit) * unit)
  return {
    v: 2, auto: true, show: keep?.show ?? true, line,
    // Column count: the format's own override, or 12 — never derived from the Frame's shape
    // (controller ruling; `kitBasics().nc` varies the suggestion with aspect ratio, which is not wanted here).
    cols: { count: fmt?.nc ?? 12, fit: 'stretch', margin, gutter: unit, width: 0 },
    rows: keep?.rows ?? { ...DEFAULT_ROWS },
  }
}

function hasLayers(props: Record<string, unknown> | undefined): boolean {
  const ls = props?.sailor_localLayers
  return Array.isArray(ls) && ls.length > 0
}

export function readLayoutGrid(props: Record<string, unknown> | undefined, W: number, H: number, fmt: FrameFormat | null): LayoutGrid {
  const raw = props?.sailor_layoutGrid as Partial<LayoutGrid> | undefined
  if (raw && raw.v === 2) {
    if (raw.auto !== false) return suggestedLayoutGrid(W, H, fmt, { show: raw.show ?? true, rows: { ...DEFAULT_ROWS, ...(raw.rows ?? {}) } })
    const s = suggestedLayoutGrid(W, H, fmt)
    return {
      v: 2, auto: false, show: raw.show ?? true, line: raw.line ?? s.line,
      cols: { ...s.cols, ...(raw.cols ?? {}) },
      rows: { ...DEFAULT_ROWS, ...(raw.rows ?? {}) },
    }
  }
  // Migration from the old sailor_localGrid (fractions of width).
  const old = props?.sailor_localGrid as { mode?: string; columns?: number; rows?: number; gutter?: number; margin?: number; overlay?: boolean } | undefined
  if (old?.mode === 'explicit') {
    const s = suggestedLayoutGrid(W, H, fmt)
    return {
      v: 2, auto: false, show: old.overlay !== false, line: s.line,
      cols: { count: clampInt(old.columns ?? 6, 1, 24), fit: 'stretch', margin: Math.min(0.45, Math.max(0, old.margin ?? 0.04)) * W, gutter: Math.max(0, old.gutter ?? 0.01) * W, width: 0 },
      rows: { mode: 'count', count: clampInt(old.rows ?? 4, 1, 24) },
    }
  }
  return suggestedLayoutGrid(W, H, fmt, { show: !hasLayers(props) })
}

export function resolveLayoutGrid(g: LayoutGrid, W: number, H: number, fmt: FrameFormat | null = null, scale = 1): ResolvedLayoutGrid {
  const unit = (g.line / 2) * scale
  const toUnit = (v: number) => Math.round(v / unit) * unit
  const n = Math.max(1, Math.round(g.cols.count))
  const gut = g.cols.gutter * scale, mar = g.cols.margin * scale
  let cw: number, x0: number
  if (g.cols.fit === 'stretch') { cw = Math.max(0, (W - 2 * mar - (n - 1) * gut) / n); x0 = mar }
  else { cw = Math.max(0, g.cols.width * scale); const all = n * cw + (n - 1) * gut; x0 = g.cols.fit === 'center' ? (W - all) / 2 : mar }
  const cols = Array.from({ length: n }, (_, i) => ({ a: x0 + i * (cw + gut), w: cw }))

  const keepTop = fmt?.keep ? fmt.keep.top * H : 0
  const keepBottom = fmt?.keep ? fmt.keep.bottom * H : 0
  const top = Math.max(unit, toUnit(mar), Math.ceil(keepTop / unit) * unit)
  const bottom = H - Math.max(mar, keepBottom)
  const gap = Math.max(unit, toUnit(gut))
  const avail = bottom - top
  let rows: Track[] = []
  // No row — not even one at the minimum height — fits in the uncovered band.
  if (avail >= unit) {
    if (g.rows.mode === 'square') {
      const mh = Math.max(unit, Math.round(cw / unit) * unit)
      const k = Math.max(0, Math.floor((avail + gap) / (mh + gap)))
      rows = Array.from({ length: k }, (_, i) => ({ a: top + i * (mh + gap), w: mh }))
    } else if (g.rows.mode === 'count') {
      const wanted = Math.max(1, Math.round(g.rows.count))
      // Cap the count so every row's pitch keeps at least the minimum row height (`unit`) and
      // the last row still ends at or before `bottom` — never force more rows than the band holds.
      const maxK = Math.max(0, Math.floor((avail + gap) / (unit + gap)))
      const k = Math.min(wanted, maxK)
      if (k >= 1) {
        // Pitch always keeps the row-to-row gap at `gap` (never eaten by clamping); floor to the
        // unit grid, but never below unit + gap.
        const pitch = Math.max(unit + gap, Math.floor((avail + gap) / k / unit) * unit)
        const mh = pitch - gap
        rows = Array.from({ length: k }, (_, i) => ({ a: top + i * pitch, w: mh }))
      }
    }
  }
  const xs = uniq([0, W / 2, W, ...cols.flatMap(c => [c.a, c.a + c.w])])
  const ys = uniq([0, H / 2, H, top, bottom, ...rows.flatMap(r => [r.a, r.a + r.w])])
  return { W, H, unit, cols, rows, margin: x0, top, bottom, xs, ys }
}

export function patchLayoutGrid(g: LayoutGrid, p: LayoutGridPatch): LayoutGrid {
  const ownsCols = p.columns != null || p.gutter != null || p.margin != null || p.fit != null || p.width != null || p.line != null
  return {
    ...g,
    auto: ownsCols ? false : g.auto,
    show: p.show ?? g.show,
    line: p.line != null ? roundLine(p.line) : g.line,
    cols: {
      count: p.columns != null ? clampInt(p.columns, 1, 24) : g.cols.count,
      fit: p.fit ?? g.cols.fit,
      margin: p.margin != null ? Math.max(0, p.margin) : g.cols.margin,
      gutter: p.gutter != null ? Math.max(0, p.gutter) : g.cols.gutter,
      width: p.width != null ? Math.max(1, p.width) : g.cols.width,
    },
    rows: { mode: p.rows ?? g.rows.mode, count: p.rowCount != null ? clampInt(p.rowCount, 1, 24) : g.rows.count },
  }
}

export function layoutGridProperty(g: LayoutGrid): { sailor_layoutGrid: LayoutGrid } {
  return { sailor_layoutGrid: g }
}

export function describeLayoutGrid(g: LayoutGrid): string {
  const rows = g.rows.mode === 'off' ? 'no rows' : g.rows.mode === 'square' ? 'square rows' : `${g.rows.count} rows`
  return `${g.cols.count} columns, ${rows}, line ${g.line} px${g.show ? '' : ', hidden'}`
}

/** The columns (and rows, when there are rows) a layer covers: 1-based first, and how many. */
export interface LayoutSpan { col: number; cols: number; row: number | null; rows: number | null }

/** First and last track a [lo, hi] extent covers: the first is the track whose START is nearest lo
 *  among those that start before hi; the last is the track whose END is nearest hi among those that
 *  end after lo. So a small box inside one track covers just that track. 0-based.
 *  A box that overlaps NO track's interior (it sits wholly inside a gutter) covers only the single
 *  nearest track, by distance from the box's centre to the track's centre — ties go to the lower index.
 *  A box straddling one track edge (its nearest start is right of its nearest end) covers the track
 *  it overlaps more — ties go to the lower index. */
function spanIdx(tracks: Track[], lo: number, hi: number): [number, number] {
  const overlapsAny = tracks.some(t => t.a < hi && t.a + t.w > lo)
  if (!overlapsAny) {
    const c = (lo + hi) / 2
    let best = 0, bd = Infinity
    tracks.forEach((t, i) => {
      const d = Math.abs((t.a + t.w / 2) - c)
      if (d < bd) { bd = d; best = i }
    })
    return [best, best]
  }
  let first = -1, last = -1, bf = Infinity, bl = Infinity
  tracks.forEach((t, i) => {
    if (t.a < hi) { const d = Math.abs(t.a - lo); if (d < bf) { bf = d; first = i } }
    if (t.a + t.w > lo) { const d = Math.abs(t.a + t.w - hi); if (d < bl) { bl = d; last = i } }
  })
  if (first < 0) first = 0
  if (last < 0) last = tracks.length - 1
  if (last < first) {
    // The box straddles one track edge without spanning a whole track: it covers the side it overlaps more.
    const ov = (t: Track) => Math.min(hi, t.a + t.w) - Math.max(lo, t.a)
    const pick = ov(tracks[last]!) >= ov(tracks[first]!) ? last : first
    return [pick, pick]
  }
  return [first, last]
}

/** The span a box (grid px) covers. Text passes its capitals-to-last-baseline extent as y/h. */
export function spanOf(box: { x: number; y: number; w: number; h: number }, r: ResolvedLayoutGrid): LayoutSpan {
  const [c0, c1] = spanIdx(r.cols, box.x, box.x + box.w)
  if (!r.rows.length) return { col: c0 + 1, cols: c1 - c0 + 1, row: null, rows: null }
  const [r0, r1] = spanIdx(r.rows, box.y, box.y + box.h)
  return { col: c0 + 1, cols: c1 - c0 + 1, row: r0 + 1, rows: r1 - r0 + 1 }
}

/** Where a span sits on the grid (px), clamped inside it. y/h are null when rows are off. */
export function placeOnSpan(s: LayoutSpan, r: ResolvedLayoutGrid): { x: number; w: number; y: number | null; h: number | null } {
  const nc = r.cols.length
  const c0 = clampInt(s.col, 1, nc) - 1
  const c1 = Math.min(nc - 1, c0 + Math.max(1, Math.round(s.cols)) - 1)
  const x = r.cols[c0]!.a, w = r.cols[c1]!.a + r.cols[c1]!.w - x
  if (!r.rows.length || s.row == null) return { x, w, y: null, h: null }
  const nr = r.rows.length
  const r0 = clampInt(s.row, 1, nr) - 1
  const r1 = Math.min(nr - 1, r0 + Math.max(1, Math.round(s.rows ?? 1)) - 1)
  const y = r.rows[r0]!.a
  return { x, w, y, h: r.rows[r1]!.a + r.rows[r1]!.w - y }
}

/** One track plus one gap (the pitch), and the gap. A single track: its own size, no gap. */
function pitchOf(tracks: Track[]): { pitch: number; gap: number } {
  if (tracks.length > 1) { const p = tracks[1]!.a - tracks[0]!.a; return { pitch: p, gap: p - tracks[0]!.w } }
  return { pitch: tracks[0]?.w ?? 0, gap: 0 }
}
/** How many tracks a length spans: n tracks are n pitches less one gap (the text box "col" unit). */
export function tracksFromLength(tracks: Track[], px: number): number {
  const { pitch, gap } = pitchOf(tracks)
  return pitch > 0 ? (px + gap) / pitch : 0
}
/** The length of n tracks: n pitches less one gap. */
export function lengthFromTracks(tracks: Track[], n: number): number {
  const { pitch, gap } = pitchOf(tracks)
  return Math.max(1, n * pitch - gap)
}
