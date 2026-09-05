/**
 * Mosh — a line-faithful port of the playgrnd "Mosh" generator, as the `mosh`
 * cell fill of a generative `deal` layer. Reimplemented from the algorithm (the
 * site has no licence; nothing here is copied — our own hash, our own rng, our own
 * structure), but every RULE of the original is kept, because the rules ARE the
 * look: a corrupted framebuffer, stacked as horizontal bands of five different
 * failures, every band nothing but filled rectangles.
 *
 *  Roles. `dark` = the ink with the lowest luminance (r·.299 + g·.587 + b·.114);
 *     `inks` = the palette; the "bright" ink is `inks[1]` (the white / paper).
 *  Pick. `pick(v, bias)`: `v < 0.16` ⇒ dark — a sixth of everything falls to the
 *     darkest ink; dead patches let the colour read. Else
 *     `n = max(1, round(len · (0.25 + mix·0.75)))` and the ink is
 *     `inks[(⌊v·n⌋ + bias) mod len]` — `mix` widens how much of the palette a band
 *     draws from.
 *  Bands. `bands` of them, UNEVEN: weight `w_i = 0.4 + h(i,3,seed+11)·1.6`,
 *     height `w/tot·H`, `y0 = round(y)`, `y1 = round(y+h)` (the last snaps to H).
 *     Kinds come from a SHUFFLED DECK of the five (Fisher–Yates from the top with
 *     `h(i,7,seed+13)`); band b gets `deck[b mod 5]` — every kind appears once
 *     before any repeats.
 *  Columns. `N = max(6, cols)`, `cw = W/N`, `wrap(i) = posmod(i, N)`. Every rect is
 *     column-quantised and drawn slightly OVERSIZED (`ceil(·)+1`) so bands and rows
 *     never show seams.
 *  Per band (`bs = seed + b·101`, every mark is `fillStyle` + `fillRect`):
 *   confetti — short horizontal RUNS, not single cells (single cells would be TV
 *     snow; corrupted data repeats a value for a few samples). `rows =
 *     max(1, round(bh/cw))`; per row, `long = h(i,j,bs+101)`; run = `long < .10 ?
 *     5 + ⌊long·260⌋ : 1 + ⌊h(i,j,bs+17)·3⌋`; colour `pick(h(i,j,bs+19), j)`.
 *   mosaic — coarse blocks `step = max(2, round(4 + h(b,5,bs+23)·5))` columns wide,
 *     `rows = max(1, round(bh/(cw·step)))`, cut by hard diagonal TEARS: `nt =
 *     tears ≤ 0 ? 0 : 1 + ⌊h(b,9,bs+29)·tears·2.6⌋` of them (≥ 1 whenever tears > 0),
 *     tear t = `{ a: h(t,11,bs+31)·rows, k: (h(t,13,bs+37)·2−1)·rows/cols2·1.8,
 *     up: h(t,15,bs+41) < .5 }`. A block is torn only where EVERY cut agrees (one
 *     cut = a half-plane, two = the wedge between them; "whichever cut says so"
 *     would blacken the band). `v = h(wrap(i·step), j, bs+43)`; torn ⇒ `v < .82 ?
 *     dark : pick(v, b)`, else `pick(v, b+j)` — the torn side keeps its grid but
 *     loses its colour.
 *   smear — long runs on THIN rows (`rows = max(2, round(bh/max(2, cw·0.6)))`): a
 *     value held far past where it should have changed. `long = 6 + runs·46`; run
 *     = `max(1, round(long·(0.25 + h(i,j·3,bs+47)·1.5)))`; colour = bright ink when
 *     `h(i,j,bs+59) < bright·.35`, else `pick(h(i,j,bs+53), j)`.
 *   scan — whole rows of one value, `rh = max(1, round(cw·(0.4 + h(0,j,bs+61)·3.2)))`
 *     tall, coloured `pick(h(1,j,bs+67), j)`; some cut by a short bright segment
 *     when `h(2,j,bs+71) < bright·.8`: width `W·(0.08 + h(3,j,bs+73)·.5)` at
 *     `x0 = W·h(4,j,bs+79)·(1−.08)`, clipped to the right edge.
 *   chevron — the column index offset by a TRIANGLE WAVE of the row ⇒ herringbone.
 *     `per = max(3, round(4 + h(b,17,bs+83)·10))`, `amp = max(1, round(2 +
 *     h(b,19,bs+89)·6))`; row j: `t = j mod 2per`, `zz = round((t < per ? t :
 *     2per − t)/per · amp)`; colour `pick(h((wrap(i)+zz) mod per, 0, bs+97), b)` —
 *     it follows the shifted column ALONE (a repeating motif, not noise).
 *  There is NO background fill: the bands cover the whole box. The source writes no
 *  alpha and no composite op, so neither does this — the layer's own opacity and
 *  blend, already on the ctx, ride through untouched.
 *
 * DOM-free (the paint function only takes a canvas-shaped ctx) so every rule
 * unit-tests without mounting anything; `moshRects` lists every rect so tests can
 * assert them without a canvas at all. The deal paint branch (drawLayerContent)
 * translates to the box and calls `paintMosh`.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'

export const MOSH_KINDS = ['confetti', 'mosaic', 'smear', 'scan', 'chevron'] as const
export type MoshKind = typeof MOSH_KINDS[number]

/** The tunables, with the original's defaults (see defaultMosh). */
export interface MoshParams {
  bands: number            // how many horizontal bands (each a different failure)
  cols: number             // cells across — everything is quantised to these columns
  mix: number              // 0..1 how much of the palette a band draws from
  tears: number            // 0..1 how many diagonal tears cut the mosaic bands
  runs: number             // 0..1 how long the smear bands hold a value
  bright: number           // 0..1 how often the bright ink cuts in (smear cells, scan segments)
  inks: string[]           // the 8 full-strength inks; inks[1] is the bright one
}

/** The five named palettes: the colour cube's corners at full strength — broken data does not fade. */
export const MOSH_PALETTE_PRESETS = {
  'Pure cube': ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00'],
  'Soft cube': ['#050505', '#F2F2F2', '#FF1E3C', '#19E65A', '#1E3CFF', '#19E6E6', '#FF19C8', '#FFE619'],
  'Print cube': ['#000000', '#E8E8E8', '#E0202A', '#00A650', '#1B4FE0', '#00C8D2', '#EC1E79', '#F5D000'],
  'Warm cube': ['#0A0A0A', '#FFFFFF', '#FF4A00', '#7CE860', '#2B4FD8', '#41C6F0', '#F03C8C', '#F0D82C'],
  'Cool cube': ['#101010', '#FAFAF5', '#D6006E', '#12B074', '#3B4FE0', '#00E0E0', '#FF6B00', '#EFEF20'],
} as const satisfies Record<string, readonly string[]>
export type MoshPresetName = keyof typeof MOSH_PALETTE_PRESETS
export const MOSH_PRESET_NAMES = Object.keys(MOSH_PALETTE_PRESETS) as MoshPresetName[]

export function defaultMosh(): MoshParams {
  return { bands: 6, cols: 150, mix: 0.62, tears: 0.55, runs: 0.5, bright: 0.3, inks: [...MOSH_PALETTE_PRESETS['Pure cube']] }
}

/** Bounds each param is clamped to (also the inspector's slider ranges). */
export const MOSH_LIMITS = {
  bands: [1, 8], cols: [24, 300], mix: [0, 1], tears: [0, 1], runs: [0, 1], bright: [0, 1],
} as const

/** The params patch a preset applies (the ink list). */
export function moshPresetPatch(name: MoshPresetName): Pick<MoshParams, 'inks'> {
  return { inks: [...MOSH_PALETTE_PRESETS[name]] }
}

/** Which preset the params currently match (every ink, in order), if any. */
export function moshPresetOf(params: MoshParams): MoshPresetName | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  for (const name of MOSH_PRESET_NAMES) {
    const p = MOSH_PALETTE_PRESETS[name]
    if (params.inks.length === p.length && params.inks.every((c, i) => same(c, p[i]!))) return name
  }
  return null
}

// 6-digit, or 8-digit with alpha (the shared colour picker emits #rrggbbaa for a
// translucent pick; canvas fillStyle accepts both).
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Clamp/normalise a (possibly partial, possibly garbage) params object onto `base`.
 *  The ink list must have at least two entries (dark + bright); bad entries fall
 *  back to the base ink at that index, a short list keeps the base's tail. */
export function normalizeMosh(partial: unknown, base: MoshParams = defaultMosh()): MoshParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  let inks = base.inks.slice()
  if (Array.isArray(p.inks) && p.inks.length >= 2) {
    inks = p.inks.map((c, i) => isHex(c) ? c : base.inks[i] ?? base.inks[0]!)
  }
  return {
    bands: Math.round(num(p.bands, MOSH_LIMITS.bands[0], MOSH_LIMITS.bands[1], base.bands)),
    cols: Math.round(num(p.cols, MOSH_LIMITS.cols[0], MOSH_LIMITS.cols[1], base.cols)),
    mix: num(p.mix, MOSH_LIMITS.mix[0], MOSH_LIMITS.mix[1], base.mix),
    tears: num(p.tears, MOSH_LIMITS.tears[0], MOSH_LIMITS.tears[1], base.tears),
    runs: num(p.runs, MOSH_LIMITS.runs[0], MOSH_LIMITS.runs[1], base.runs),
    bright: num(p.bright, MOSH_LIMITS.bright[0], MOSH_LIMITS.bright[1], base.bright),
    inks,
  }
}

// ── The hash ─────────────────────────────────────────────────────────────────

/** Our own 2-int + salt hash → [0,1): fold the three through odd multiplies with a
 *  rotate between them, then let mulberry32's finaliser avalanche the result, so
 *  (a, b, salt) triples that differ in one place land anywhere. Every rule below
 *  keys off a DISTINCT salt (the source's 3/7/11/13 and 17…101 per role) so the
 *  streams are independent. */
export function moshHash(a: number, b: number, salt: number): number {
  let h = Math.imul(salt | 0, 0x9e3779b1) >>> 0
  h = Math.imul((h ^ (a | 0)) >>> 0, 0x85ebca77) >>> 0
  h = ((h << 13) | (h >>> 19)) >>> 0
  h = Math.imul((h ^ (b | 0)) >>> 0, 0xc2b2ae3d) >>> 0
  h = ((h << 17) | (h >>> 15)) >>> 0
  return mulberry32(h ^ 0x5bd1e995)()
}

/** The per-deal seed base: the deal's integer seed keyed to this generator. */
export function moshSeedBase(seed: number): number {
  return hashSeed(`${seed}:mosh`) | 0
}

// ── Roles + pick ─────────────────────────────────────────────────────────────

export interface MoshRoles { dark: string; bright: string; inks: readonly string[] }

/** Luminance of a hex colour, the source's weights: r·.299 + g·.587 + b·.114. */
export function moshLuminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16)
  if (!Number.isFinite(n)) return 0
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return r * 0.299 + g * 0.587 + b * 0.114
}

/** Roles — `dark` is the lowest-luminance ink; `bright` is inks[1]; `inks` the palette. */
export function moshRoles(palette: readonly string[]): MoshRoles {
  const inks = palette.length >= 2 ? palette : [...MOSH_PALETTE_PRESETS['Pure cube']]
  let dark = inks[0]!
  for (const c of inks) if (moshLuminance(c) < moshLuminance(dark)) dark = c
  return { dark, bright: inks[1]!, inks }
}

/** Pick — `v < .16` ⇒ dark; else `inks[(⌊v·n⌋ + bias) mod len]` with
 *  `n = max(1, round(len·(.25 + mix·.75)))`. */
export function moshPick(v: number, bias: number, roles: MoshRoles, mix: number): string {
  if (v < 0.16) return roles.dark
  const len = roles.inks.length
  const n = Math.max(1, Math.round(len * (0.25 + mix * 0.75)))
  return roles.inks[(((Math.floor(v * n) + bias) % len) + len) % len]!
}

// ── Bands + the deck ─────────────────────────────────────────────────────────

export interface MoshBand { b: number; y0: number; y1: number; kind: MoshKind }

/** The shuffled deck: Fisher–Yates from the top, `j = ⌊h(i,7,seed+13)·(i+1)⌋`. */
export function moshDeck(seed: number): MoshKind[] {
  const base = moshSeedBase(seed)
  const deck: MoshKind[] = [...MOSH_KINDS]
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(moshHash(i, 7, base + 13) * (i + 1))
    const t = deck[i]!; deck[i] = deck[j]!; deck[j] = t
  }
  return deck
}

/** Bands — uneven heights from weights `.4 + h(i,3,seed+11)·1.6`, rounded edges,
 *  the last snapping to H; kinds dealt from the shuffled deck, `deck[b mod 5]`. */
export function moshBands(params: MoshParams, H: number, seed: number): MoshBand[] {
  const nb = Math.max(1, Math.round(params.bands))
  const base = moshSeedBase(seed)
  const wts: number[] = []
  let tot = 0
  for (let i = 0; i < nb; i++) { const w = 0.4 + moshHash(i, 3, base + 11) * 1.6; wts.push(w); tot += w }
  const deck = moshDeck(seed)
  const out: MoshBand[] = []
  let y = 0
  for (let b = 0; b < nb; b++) {
    const h = wts[b]! / tot * H
    const y0 = Math.round(y), y1 = b === nb - 1 ? H : Math.round(y + h)
    y += h
    out.push({ b, y0, y1, kind: deck[b % deck.length]! })
  }
  return out
}

// ── Per-band rects ───────────────────────────────────────────────────────────

/** One filled rectangle in box pixels, plus the cell span it came from:
 *  columns `[i0, i1)` on row `j` (scan rows span the full width, i0 = 0, i1 = N). */
export interface MoshRect { x: number; y: number; w: number; h: number; col: string; i0: number; i1: number; j: number }

/** The column layout every band shares. */
export interface MoshColumns { N: number; cw: number; W: number }

export function moshColumns(params: MoshParams, W: number): MoshColumns {
  const N = Math.max(6, Math.round(params.cols))
  return { N, cw: W / N, W }
}

const wrapN = (i: number, N: number) => ((i % N) + N) % N

/** A run of columns `[i, i+run)` on row j as a column-snapped, oversized rect. */
function runRect(c: MoshColumns, by: number, rh: number, i: number, run: number, j: number, col: string): MoshRect {
  const i1 = Math.min(c.N, i + run)
  const x0 = Math.round(i * c.cw), x1 = Math.round(i1 * c.cw)
  return { x: x0, y: Math.round(by + j * rh), w: x1 - x0, h: Math.ceil(rh) + 1, col, i0: i, i1, j }
}

/** confetti — short runs (1..3; 10% long 5..265) per row, rows one column tall. */
export function moshConfettiRects(c: MoshColumns, roles: MoshRoles, mix: number, by: number, bh: number, bs: number): MoshRect[] {
  const rows = Math.max(1, Math.round(bh / c.cw)), rh = bh / rows
  const out: MoshRect[] = []
  for (let j = 0; j < rows; j++) {
    let i = 0
    while (i < c.N) {
      const w = wrapN(i, c.N)
      const r = moshHash(w, j, bs + 17), long = moshHash(w, j, bs + 101)
      const run = long < 0.10 ? 5 + Math.floor(long * 260) : 1 + Math.floor(r * 3)
      const col = moshPick(moshHash(w, j, bs + 19), j, roles, mix)
      out.push(runRect(c, by, rh, i, run, j, col))
      i += run
    }
  }
  return out
}

/** One diagonal tear: the cut `edge(i) = a + k·i` in row units; `up` keeps the
 *  side ABOVE it (`j < edge`), else the side below (`j > edge`). */
export interface MoshTear { a: number; k: number; up: boolean }

/** mosaic's block step: `max(2, round(4 + h(b,5,bs+23)·5))` (4..9 columns). */
export function moshMosaicStep(b: number, bs: number): number {
  return Math.max(2, Math.round(4 + moshHash(b, 5, bs + 23) * 5))
}

/** mosaic's tears for a band: `nt = tears ≤ 0 ? 0 : 1 + ⌊h(b,9,bs+29)·tears·2.6⌋`. */
export function moshMosaicTears(b: number, bs: number, tears: number, rows: number, cols2: number): MoshTear[] {
  const nt = tears <= 0 ? 0 : 1 + Math.floor(moshHash(b, 9, bs + 29) * tears * 2.6)
  const out: MoshTear[] = []
  for (let t = 0; t < nt; t++) {
    out.push({
      a: moshHash(t, 11, bs + 31) * rows,
      k: (moshHash(t, 13, bs + 37) * 2 - 1) * rows / cols2 * 1.8,
      up: moshHash(t, 15, bs + 41) < 0.5,
    })
  }
  return out
}

/** Torn only where EVERY cut agrees (the intersection: a half-plane for one cut,
 *  the wedge between two); no cuts ⇒ nothing is torn. */
export function moshTorn(tears: readonly MoshTear[], i: number, j: number): boolean {
  if (!tears.length) return false
  for (const t of tears) {
    const edge = t.a + t.k * i
    if (!(t.up ? j < edge : j > edge)) return false
  }
  return true
}

/** mosaic — coarse `step`-column blocks with hard diagonal tears. Returns the rects
 *  plus the layout so tests can check the tear rule per block. */
export function moshMosaicRects(c: MoshColumns, roles: MoshRoles, params: Pick<MoshParams, 'mix' | 'tears'>, by: number, bh: number, b: number, bs: number): { rects: MoshRect[]; step: number; rows: number; cols2: number; tears: MoshTear[]; torn: boolean[] } {
  const step = moshMosaicStep(b, bs)
  const cols2 = Math.ceil(c.N / step)
  const rows = Math.max(1, Math.round(bh / (c.cw * step))), rh = bh / rows
  const tears = moshMosaicTears(b, bs, params.tears, rows, cols2)
  const rects: MoshRect[] = [], torn: boolean[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols2; i++) {
      const isTorn = moshTorn(tears, i, j)
      const v = moshHash(wrapN(i * step, c.N), j, bs + 43)
      const col = isTorn
        ? (v < 0.82 ? roles.dark : moshPick(v, b, roles, params.mix))
        : moshPick(v, b + j, roles, params.mix)
      rects.push(runRect(c, by, rh, i * step, step, j, col))
      torn.push(isTorn)
    }
  }
  return { rects, step, rows, cols2, tears, torn }
}

/** smear's row height: thin rows, `max(2, cw·0.6)` px each. */
export function moshSmearRows(c: MoshColumns, bh: number): number {
  return Math.max(2, Math.round(bh / Math.max(2, c.cw * 0.6)))
}

/** smear — long runs on thin rows; some cells bright. */
export function moshSmearRects(c: MoshColumns, roles: MoshRoles, params: Pick<MoshParams, 'mix' | 'runs' | 'bright'>, by: number, bh: number, bs: number): MoshRect[] {
  const rows = moshSmearRows(c, bh), rh = bh / rows
  const long = 6 + params.runs * 46
  const out: MoshRect[] = []
  for (let j = 0; j < rows; j++) {
    let i = 0
    while (i < c.N) {
      const w = wrapN(i, c.N)
      const r = moshHash(w, j * 3, bs + 47)
      const run = Math.max(1, Math.round(long * (0.25 + r * 1.5)))
      const v = moshHash(w, j, bs + 53)
      const col = moshHash(w, j, bs + 59) < params.bright * 0.35 ? roles.bright : moshPick(v, j, roles, params.mix)
      out.push(runRect(c, by, rh, i, run, j, col))
      i += run
    }
  }
  return out
}

/** scan — full-width rows of one value, some cut by a short bright segment. */
export function moshScanRects(c: MoshColumns, roles: MoshRoles, params: Pick<MoshParams, 'mix' | 'bright'>, by: number, bh: number, bs: number): MoshRect[] {
  const out: MoshRect[] = []
  const W = c.W
  let yy = by, j = 0
  while (yy < by + bh) {
    const r = moshHash(0, j, bs + 61)
    const rh = Math.max(1, Math.round(c.cw * (0.4 + r * 3.2)))
    const hh = Math.min(rh, by + bh - yy)
    const y = Math.round(yy), h = Math.ceil(hh) + 1
    out.push({ x: 0, y, w: W, h, col: moshPick(moshHash(1, j, bs + 67), j, roles, params.mix), i0: 0, i1: c.N, j })
    if (moshHash(2, j, bs + 71) < params.bright * 0.8) {
      const w = W * (0.08 + moshHash(3, j, bs + 73) * 0.5)
      const x0 = W * moshHash(4, j, bs + 79) * (1 - 0.08)
      out.push({ x: Math.round(x0), y, w: Math.round(Math.min(w, W - x0)), h, col: roles.bright, i0: 0, i1: c.N, j })
    }
    yy += hh; j++
  }
  return out
}

/** chevron's motif: `per` (3..14) and `amp` (1..8). */
export function moshChevronSpec(b: number, bs: number): { per: number; amp: number } {
  return {
    per: Math.max(3, Math.round(4 + moshHash(b, 17, bs + 83) * 10)),
    amp: Math.max(1, Math.round(2 + moshHash(b, 19, bs + 89) * 6)),
  }
}

/** chevron's column shift for row j: a triangle wave of period 2·per and amplitude amp. */
export function moshChevronShift(j: number, per: number, amp: number): number {
  const t = j % (per * 2)
  return Math.round((t < per ? t : per * 2 - t) / per * amp)
}

/** chevron — every cell one column wide; its colour follows the shifted column alone. */
export function moshChevronRects(c: MoshColumns, roles: MoshRoles, mix: number, by: number, bh: number, b: number, bs: number): MoshRect[] {
  const rows = Math.max(1, Math.round(bh / c.cw)), rh = bh / rows
  const { per, amp } = moshChevronSpec(b, bs)
  const out: MoshRect[] = []
  for (let j = 0; j < rows; j++) {
    const zz = moshChevronShift(j, per, amp)
    for (let i = 0; i < c.N; i++) {
      const col = moshPick(moshHash((wrapN(i, c.N) + zz) % per, 0, bs + 97), b, roles, mix)
      out.push({ x: Math.round(i * c.cw), y: Math.round(by + j * rh), w: Math.ceil(c.cw) + 1, h: Math.ceil(rh) + 1, col, i0: i, i1: i + 1, j })
    }
  }
  return out
}

/** The band's seed: `bs = seed + b·101`. */
export const moshBandSeed = (seed: number, b: number) => moshSeedBase(seed) + b * 101

/** Every rect of one band, by its kind. */
export function moshBandRects(c: MoshColumns, roles: MoshRoles, params: MoshParams, band: MoshBand, seed: number): MoshRect[] {
  const by = band.y0, bh = band.y1 - band.y0, bs = moshBandSeed(seed, band.b)
  switch (band.kind) {
    case 'confetti': return moshConfettiRects(c, roles, params.mix, by, bh, bs)
    case 'mosaic': return moshMosaicRects(c, roles, params, by, bh, band.b, bs).rects
    case 'smear': return moshSmearRects(c, roles, params, by, bh, bs)
    case 'scan': return moshScanRects(c, roles, params, by, bh, bs)
    case 'chevron': return moshChevronRects(c, roles, params.mix, by, bh, band.b, bs)
  }
}

/** The whole composition over a pixel box as a rect list, for tests and proofs. */
export interface MoshLayout { columns: MoshColumns; roles: MoshRoles; bands: MoshBand[]; rects: MoshRect[][] }

export function moshRects(params: MoshParams, palette: readonly string[], boxW: number, boxH: number, seed: number): MoshLayout {
  const p = normalizeMosh(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const columns = moshColumns(p, W)
  const roles = moshRoles(palette)
  const bands = moshBands(p, H, seed)
  return { columns, roles, bands, rects: bands.map(band => moshBandRects(columns, roles, p, band, seed)) }
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The subset of a 2D context the paint needs — fillStyle + fillRect and NOTHING
 *  else (no alpha, no composite op: the layer's own ride through untouched). */
export type MoshCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>

/** Paint the composition at the ctx's origin over `boxW × boxH`: every band's
 *  rects in order, each `fillStyle` + `fillRect`. No background — the bands cover
 *  the box. */
export function paintMosh(ctx: MoshCtx, params: MoshParams, palette: readonly string[], boxW: number, boxH: number, seed: number): MoshLayout {
  const layout = moshRects(params, palette, boxW, boxH, seed)
  for (const band of layout.rects) {
    for (const r of band) {
      ctx.fillStyle = r.col
      ctx.fillRect(r.x, r.y, r.w, r.h)
    }
  }
  return layout
}
