/**
 * Pane — a line-faithful port of the playgrnd "Pane" generator, as the `pane` cell
 * fill of a generative `deal` layer. Reimplemented from the algorithm (the site has
 * no licence; nothing here is copied — our own rng, our own structure), but every
 * RULE of the original is kept, because the rules ARE the look:
 *
 *  1. `weights(n)`: n uneven shares, `1 + (h·2−1)·vary·0.85`, normalised to sum 1.
 *  2. Rows stack top→bottom by weights; the last row snaps to the box bottom.
 *  3. Each row has its OWN cell COUNT, `round(cells·(0.55 + h·0.9))` (so `cells:6`
 *     gives 3–9 per row — this is most of what stops the rows lining up), with its
 *     own widths. Cells are FLUSH (exact bounds, no gap) and EVERY cell is filled.
 *  4. Direction: one hash picks the family (flat vs diagonal, by `diag`), another
 *     the member; the gradient runs corner/edge → corner/edge of the cell (a VECTOR
 *     in cell fractions — never an arbitrary angle). That crispness is the look.
 *  5. Inks by PALETTE DISTANCE: `a` random, `b = a + step` where step reaches at
 *     most `1 + spread·(n−2)` places along the ORDERED palette (`spread:0` ⇒
 *     neighbours, `spread:1` ⇒ up to the far end).
 *  6. `soft` = how much of the cell is the blend: the ramp runs p0..p1, with
 *     `soft:1` the whole cell and `soft:0` a hard line near the middle.
 *  7. The ramp walks HSL the SHORT way round the wheel, 8 interior stops, an
 *     achromatic end borrowing the other end's hue — so a middle stays saturated
 *     where a straight sRGB blend would go grey.
 *
 * DOM-free + no draw engine — pure so it unit-tests without mounting anything. The
 * deal paint branch (drawLayerContent) walks `paneRegions` and builds one canvas
 * linear gradient per cell from `paneCellGradient`'s exact endpoints.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'
import { hexToRgb, rgbToHex } from '~/lib/color/convert'
import { dealVocabItems, type DealVocab } from '~/lib/compositor/dealVocab'

/** The tunables, with the original's defaults (see defaultPane). */
export interface PaneParams {
  rows: number     // row count (int ≥ 1)
  cells: number    // NOMINAL cells per row; each row varies it ×(0.55..1.45)
  vary: number     // 0..1 how uneven rows/cells are (0 = all equal)
  diag: number     // 0..1 share of cells whose gradient runs corner-to-corner
  soft: number     // 0..1 how much of the cell is the blend (0 = hard line)
  spread: number   // 0..1 how far apart in the palette ORDER the two inks are drawn
  /** The ORDERED palette `spread` walks (the original's 8-colour list). Fewer than
   *  2 (or absent — layers saved before this field) ⇒ the deal vocabulary's solids. */
  inks?: string[]
}

/**
 * The original's five ordered 8-colour palettes, exact and in its order. The ORDER is
 * part of the look — `spread` is a distance along it (pink → blue → orange → lavender
 * → pale pink → white → violet → sky), so a neighbour pair is always a designed pair.
 */
export const PANE_PALETTE_PRESETS = {
  'Hot pink': ['#FF3BD4', '#0B62F0', '#FF4A0A', '#D6B4FA', '#FFC9F2', '#FFFFFF', '#8B5CF6', '#4FA8FF'],
  'Electric': ['#FF2FA8', '#1E4FE0', '#FF6A00', '#C7B2F5', '#FFD6EE', '#FBF8FF', '#7A3BE0', '#38C6FF'],
  'Deep': ['#E8207A', '#0A3FD6', '#F55A1E', '#B9A6F0', '#FFC0DE', '#FFFFFF', '#6D28D9', '#22B8F0'],
  'Sorbet': ['#FF4FA0', '#2B4FD8', '#FFA02C', '#A8D8F5', '#FFE0F0', '#FFFDF7', '#5B2BD6', '#41E0C8'],
  'Candy': ['#F0308C', '#1B2FA8', '#FF7A1E', '#D8C4F0', '#FFE8F4', '#FFFFFF', '#9B4FE0', '#2CC8F0'],
} as const satisfies Record<string, readonly string[]>
export type PanePresetName = keyof typeof PANE_PALETTE_PRESETS
export const PANE_PRESET_NAMES = Object.keys(PANE_PALETTE_PRESETS) as PanePresetName[]

/** The original's defaults — including its first palette, so a fresh Pane reads in
 *  the tool's pink / blue / orange / lavender / white register, not the brand vocab. */
export function defaultPane(): PaneParams {
  return { rows: 3, cells: 6, vary: 0.55, diag: 0.45, soft: 0.85, spread: 0.55, inks: [...PANE_PALETTE_PRESETS['Hot pink']] }
}

/** Bounds each param is clamped to (also the inspector's slider ranges). */
export const PANE_LIMITS = { rows: [1, 8], cells: [1, 12] } as const

/** The params patch a preset applies (the ordered ink list). */
export function panePresetPatch(name: PanePresetName): Pick<PaneParams, 'inks'> {
  return { inks: [...PANE_PALETTE_PRESETS[name]] }
}

/** Which preset the params currently match (every ink, in order), if any. */
export function panePresetOf(params: PaneParams): PanePresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of PANE_PRESET_NAMES) {
    const p = PANE_PALETTE_PRESETS[name]
    if (params.inks?.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas gradient stops accept both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`.
 *  `inks` keeps only valid hex, and needs at least 2 to count as a palette — fewer
 *  ⇒ [] (the vocabulary fallback); absent ⇒ the base's list. */
export function normalizePane(partial: unknown, base: PaneParams = defaultPane()): PaneParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  let inks: string[]
  if (Array.isArray(p.inks)) {
    const valid = p.inks.filter(isHex)
    inks = valid.length >= 2 ? valid : []
  } else {
    inks = (base.inks ?? []).slice()
  }
  return {
    rows: Math.round(num(p.rows, PANE_LIMITS.rows[0], PANE_LIMITS.rows[1], base.rows)),
    cells: Math.round(num(p.cells, PANE_LIMITS.cells[0], PANE_LIMITS.cells[1], base.cells)),
    vary: num(p.vary, 0, 1, base.vary),
    diag: num(p.diag, 0, 1, base.diag),
    soft: num(p.soft, 0, 1, base.soft),
    spread: num(p.spread, 0, 1, base.spread),
    inks,
  }
}

/**
 * The only 8 directions a Pane cell can take, as `[x0, y0, x1, y1]` in cell
 * fractions: the gradient runs from `(x + x0·w, y + y0·h)` to `(x + x1·w, y + y1·h)`.
 * EVEN indices are the 4 flats (L→R, T→B, R→L, B→T); ODD are the 4 corner diagonals.
 */
export const PANE_DIRS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 1, 0], [0, 0, 1, 1], [0, 0, 0, 1], [1, 0, 0, 1],
  [1, 0, 0, 0], [1, 1, 0, 0], [0, 1, 0, 0], [0, 1, 1, 0],
]

/** One seeded value in [0,1) for a namespaced role. Every role gets its own tag
 *  (the original uses distinct integer salts 3/5/11+7j/13/17/19/23/29/31 for the
 *  same independence) so e.g. a cell's direction never correlates with its inks. */
function h(tag: string): number {
  return mulberry32(hashSeed(tag))()
}

/**
 * Rule 1 — n uneven shares that sum to 1. `vary` sets how uneven; `vary:0` ⇒ all
 * equal. `salt` names the stream ('rowh' for row heights, `colw:${j}` for row j's
 * widths) so every row's widths are independent of every other row's.
 */
export function paneWeights(n: number, vary: number, seed: number, salt: string): number[] {
  const count = Math.max(1, Math.round(n))
  const w: number[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    const v = 1 + (h(`${seed}:pane-w:${salt}:${i}`) * 2 - 1) * vary * 0.85
    w.push(v); total += v
  }
  return w.map(v => v / total)
}

/** A cell of the Pane masonry: pixel rect + its (column, row) position, which is
 *  what the per-cell hashes key on (like the original's `hsh(i, j, seed+salt)`). */
export interface PaneRegion { x: number; y: number; w: number; h: number; i: number; j: number }

/**
 * Rules 2–3 — Pane's own row-masonry over a `boxW × boxH` box, in pixels. Rows stack
 * by weights (last snaps to the bottom); each row picks its OWN cell count and its
 * own widths (last snaps to the right). Cells are FLUSH and every one is returned —
 * Pane has no density / inset / merge; a cell that rounds to zero size is skipped
 * (the original's `cell()` early-returns on it), which keeps neighbours flush.
 */
export function paneRegions(params: PaneParams, boxW: number, boxH: number, seed: number): PaneRegion[] {
  const p = normalizePane(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const out: PaneRegion[] = []
  const rh = paneWeights(p.rows, p.vary, seed, 'rowh')
  let y = 0
  for (let j = 0; j < p.rows; j++) {
    const y0 = Math.round(y * H)
    const y1 = j === p.rows - 1 ? H : Math.round((y + rh[j]!) * H)
    y += rh[j]!
    // The cell COUNT varies row to row (×0.55..1.45 of the nominal count).
    const nc = Math.max(1, Math.round(p.cells * (0.55 + h(`${seed}:pane-rowcount:${j}`) * 0.9)))
    const cwt = paneWeights(nc, p.vary, seed, `colw:${j}`)
    let x = 0
    for (let i = 0; i < nc; i++) {
      const x0 = Math.round(x * W)
      const x1 = i === nc - 1 ? W : Math.round((x + cwt[i]!) * W)
      x += cwt[i]!
      const w = x1 - x0, hh = y1 - y0
      if (w <= 0 || hh <= 0) continue
      out.push({ x: x0, y: y0, w, h: hh, i, j })
    }
  }
  return out
}

/** Rules 4–6 resolved for one cell: which direction, which two palette indices, and
 *  the ramp extent. Exported so each rule is testable on its own. */
export interface PaneCellPick {
  dirIndex: number                                     // 0..7 into PANE_DIRS (even = flat, odd = diagonal)
  dir: readonly [number, number, number, number]
  a: number; b: number                                 // palette indices of the two inks
  p0: number; p1: number                               // ramp extent along the gradient (0..1)
}

export function paneCellPick(params: PaneParams, paletteSize: number, seed: number, i: number, j: number): PaneCellPick {
  const p = normalizePane(params)
  const tag = (role: string) => h(`${seed}:pane-${role}:${i}:${j}`)
  // Rule 4 — one hash picks the family (flat / diagonal), another the member.
  const wantD = tag('dir-fam') < p.diag
  const dirIndex = (Math.floor(tag('dir-mem') * 4) * 2 + (wantD ? 1 : 0)) & 7
  // Rule 5 — inks by distance in the palette ORDER.
  const n = Math.max(1, Math.floor(paletteSize))
  const a = Math.min(n - 1, Math.floor(tag('ink-a') * n))
  const reach = Math.max(1, Math.round(1 + p.spread * (n - 2)))
  const step = 1 + Math.floor(tag('ink-step') * reach)
  const b = (a + step) % n
  // Rule 6 — how much of the cell is the blend.
  const sp = 0.5 * (1 - p.soft)
  const p0 = Math.min(0.49, sp * (0.4 + tag('p0') * 1.2))
  const p1 = Math.max(0.51, 1 - sp * (0.4 + tag('p1') * 1.2))
  return { dirIndex, dir: PANE_DIRS[dirIndex]!, a, b, p0, p1 }
}

// ── HSL (Pane's ramp space; the repo's hueWalk is OKLCH, so we match HSL here) ──

/** #rrggbb → [h (deg, 0..360), s (0..1), l (0..1)]. */
export function hexToHsl(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb(hex)
  const r = r8 / 255, g = g8 / 255, b = b8 / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let hue: number
  if (max === r) hue = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  return [hue * 60, s, l]
}

/** [h (deg, any), s (0..1), l (0..1)] → #rrggbb. */
export function hslToHex(hue: number, s: number, l: number): string {
  const hh = ((hue % 360) + 360) % 360 / 360
  const sc = Math.max(0, Math.min(1, s)), lc = Math.max(0, Math.min(1, l))
  if (sc === 0) { const v = lc * 255; return rgbToHex(v, v, v) }
  const q = lc < 0.5 ? lc * (1 + sc) : lc + sc - lc * sc
  const p = 2 * lc - q
  const chan = (t0: number) => {
    let t = t0; if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return rgbToHex(chan(hh + 1 / 3) * 255, chan(hh) * 255, chan(hh - 1 / 3) * 255)
}

export interface PaneStop { offset: number; color: string }

/** Interior stop count of the ramp (rule 7). */
export const PANE_RAMP_STEPS = 8

/**
 * Rule 7 — the stops of a two-ink ramp that occupies `p0..p1` of the gradient:
 * `0→A`, `p0→A` (if p0>0), 8 interior HSL stops walking the SHORT arc of the hue
 * wheel (an achromatic ink, s<0.04, borrows its partner's hue so the walk never
 * spins through unrelated hues), `p1→B` (if p1<1), `1→B`.
 */
export function paneRampStops(inkA: string, inkB: string, p0: number, p1: number): PaneStop[] {
  const A = hexToHsl(inkA), B = hexToHsl(inkB)
  if (A[1] < 0.04) A[0] = B[0]
  if (B[1] < 0.04) B[0] = A[0]
  let dh = B[0] - A[0]
  if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  const stops: PaneStop[] = [{ offset: 0, color: inkA }]
  if (p0 > 0) stops.push({ offset: p0, color: inkA })
  for (let k = 1; k < PANE_RAMP_STEPS; k++) {
    const t = k / PANE_RAMP_STEPS
    stops.push({
      offset: p0 + (p1 - p0) * t,
      color: hslToHex(A[0] + dh * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t),
    })
  }
  if (p1 < 1) stops.push({ offset: p1, color: inkB })
  stops.push({ offset: 1, color: inkB })
  return stops
}

/** What one Pane cell is painted with: a linear gradient whose endpoints are in
 *  CELL FRACTIONS (a corner or edge midpoint each) plus its stops. */
export interface PaneCellGradient {
  type: 'linear'
  x0: number; y0: number; x1: number; y1: number
  stops: PaneStop[]
  pick: PaneCellPick
}

/** Used only when a palette offers no inks at all — a graceful pair so the
 *  generator never throws (the real vocabularies all have several solids). */
const FALLBACK_INKS = ['#0e6bff', '#ff6259'] as const

/**
 * Rules 4–7 for cell (i, j): direction vector + short-arc HSL ramp between two
 * palette-distance inks. `palette` is ORDERED — `spread` is a distance along it.
 */
export function paneCellGradient(params: PaneParams, palette: readonly string[], seed: number, i: number, j: number): PaneCellGradient {
  const pal = palette.length ? palette : FALLBACK_INKS
  const pick = paneCellPick(params, pal.length, seed, i, j)
  const [x0, y0, x1, y1] = pick.dir
  return {
    type: 'linear', x0, y0, x1, y1, pick,
    stops: paneRampStops(pal[pick.a]!, pal[pick.b]!, pick.p0, pick.p1),
  }
}

/**
 * Fallback palette for a deal with no `inks`: the SOLID (string) paints of its
 * vocabulary, in declaration order — that order is what `spread` walks.
 */
export function paneInksFromVocab(vocab: DealVocab): string[] {
  return dealVocabItems(vocab).map(it => it.paint).filter((p): p is string => typeof p === 'string')
}

/** The ORDERED palette a Pane deal paints with: its own `inks` when it has at least
 *  2, else the vocabulary's solids (layers saved before `inks` existed keep looking
 *  exactly as they did). */
export function panePalette(params: PaneParams, vocab: DealVocab): string[] {
  if ((params.inks?.length ?? 0) >= 2) return params.inks!.slice()
  return paneInksFromVocab(vocab)
}
